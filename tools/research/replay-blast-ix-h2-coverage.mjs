/** Run targeted pro-history validation in a disposable copy of local PostgreSQL. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {createDatabase,sql,SeriesProvisionRepository} from '../../packages/db/dist/index.js';
import {IngestionService} from '../../packages/ingestion/dist/index.js';
import {assertIsolatedTarget,REPLAY_ADAPTER} from './post-draft-history-replay.mjs';

const directory = '.tools/blast-ix-h2-diagnostic-20261122-r3';
const evidence = '.tools/blast-ix-h2-coverage-r1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);
const sourceUrl = new URL(process.env.DATABASE_URL);
const name = 'codex_s304_dry_' + randomBytes(8).toString('hex');
const cloneUrl = new URL(sourceUrl);
cloneUrl.pathname = '/' + name;
assertIsolatedTarget(sourceUrl.href,cloneUrl.href,name,name);
const source = createDatabase(sourceUrl.href);
const dump = resolve(directory,'temporary-source.dump');
const pgEnv = {...process.env, PGHOST:sourceUrl.hostname, PGPORT:sourceUrl.port || '5432',
  PGDATABASE:decodeURIComponent(sourceUrl.pathname.slice(1)), PGUSER:decodeURIComponent(sourceUrl.username),
  PGPASSWORD:decodeURIComponent(sourceUrl.password)};
const pg = (name,args) => exec(resolve('.tools/pgsql/bin',name+'.exe'),args,{env:pgEnv, windowsHide:true, timeout:240000});
const state = async db => (await sql`SELECT (SELECT count(*)::int FROM matches) AS maps,
  (SELECT count(*)::int FROM series) AS series,(SELECT count(*)::int FROM provider_ingest_receipts) AS receipts,
  (SELECT count(*)::int FROM prediction_runs) AS predictions`.execute(db)).rows[0];

let clone, created = false, dumpOwned = false;
try {
  assert.equal(process.argv.length,2);
  const bytes = await readFile(join(evidence,'prior-details.json'));
  const captures = JSON.parse(bytes);
  const discoveryBytes = await readFile(join(evidence,'discovery.json'));
  assert.equal(captures.discoverySha256,sha(discoveryBytes));
  const discovery = JSON.parse(discoveryBytes);
  const cohort = JSON.parse(await readFile(join(directory,'cohort.json')));
  const frozenIds = new Set(cohort.rows.map(row=>row.match_id));
  const allowed = new Set(discovery.fresh.map(row=>row.match_id));
  assert(allowed.size <= 20 && captures.eligible.length > 0);
  const observations = new Map(captures.eligible.map(row => {
    assert(allowed.has(row.id) && !frozenIds.has(row.id));
    const rawBody = JSON.stringify(row.projection);
    assert.equal(row.payloadSha256,sha(rawBody));
    assert.equal(row.source.endpoint,'/matches/'+row.id);
    assert.equal(row.source.knownAt,null);
    assert.match(row.source.payloadSha256,/^[a-f0-9]{64}$/);
    assert((row.projection.start_time + row.projection.duration)*1000 < Date.parse(discovery.cutoff));
    return [row.id,{data:row.projection,rawBody,source:{...row.source,adapterVersion:REPLAY_ADAPTER,payloadSha256:row.payloadSha256,attempts:0}}];
  }));
  assert.equal(observations.size,captures.eligible.length);
  const before = await state(source);
  await writeFile(dump,'',{flag:'wx'});
  dumpOwned = true;
  await pg('pg_dump',['--format=custom','--no-owner','--file',dump]);
  await sql`CREATE DATABASE ${sql.id(name)} TEMPLATE template0`.execute(source);
  created = true;
  await pg('pg_restore',['--exit-on-error','--no-owner','--dbname',name,dump]);
  clone = createDatabase(cloneUrl.href);
  const actual = (await sql`SELECT current_database() AS name`.execute(clone)).rows[0].name;
  assertIsolatedTarget(sourceUrl.href,cloneUrl.href,name,actual);
  assert.deepEqual(await state(clone),before);
  const importer = new IngestionService(clone,{getHeroes:async()=>captures.heroes,
    getLeagues:async()=>captures.leagues,getMatchSource:async id=>{
      assert(observations.has(id),'out_of_scope_map');
      return observations.get(id);
    }});
  for (const id of observations.keys()) await importer.ingest(id);
  const repo = new SeriesProvisionRepository(clone);
  const series = [];
  for (const id of new Set(captures.eligible.map(row=>row.seriesId))) {
    const request = {providerSeriesIds:[id],snapshotAt:new Date().toISOString()};
    const preview = await repo.preview(request);
    const result = preview.status === 'ready' ? await repo.apply(request,preview.fingerprint) : null;
    series.push({id,status:preview.status,created:result?.created ?? 0,reasons:preview.groups.flatMap(g=>g.reasons)});
  }
  const maps = [];
  for (const id of observations.keys()) {
    const result = await importer.ingest(id);
    maps.push({id,status:result.status,receiptId:result.receiptId});
  }
  // The history exporter runs against the isolated database only.
  const outcome = await exec(process.execPath,['tools/research/prepare-blast-ix-h2-history.mjs',directory],
    {env:{...process.env,DATABASE_URL:cloneUrl.href}, windowsHide:true, timeout:180000});
  const history = JSON.parse(await readFile(join(directory,'history.json')));
  const importedIds = new Set(maps.map(row=>row.id));
  const eligibleMaps = history.history.maps.filter(row=>importedIds.has(row.matchId)).map(row=>row.matchId);
  const after = await state(clone);
  assert.deepEqual(await state(source),before,'working_match_or_prediction_state_changed');
  assert.equal(after.predictions,before.predictions);
  await writeFile(join(directory,'history-replay.json'),JSON.stringify({before,after,maps,series,eligibleMaps,
    priorDetailsSha256:sha(bytes), workingBusinessWrites:0, activationAllowed:false})+'\n',{flag:'wx'});
  console.log(outcome.stdout.trim());
  console.log(JSON.stringify({imported:maps.length,eligible:eligibleMaps.length,series:series.length,accepted:maps.filter(r=>r.status==='accepted').length}));
} catch (error) {
  // Never forward subprocess stderr or a connection URL into the operator console.
  console.error(JSON.stringify({status:'blocked',code:error.code??'coverage_replay_guard',
    reason:typeof error.cmd==='string'?'isolated_database_or_export_failed':error.message.split('\n')[0]}));
  process.exitCode = 1;
} finally {
  await clone?.destroy();
  if (created) {
    assertIsolatedTarget(sourceUrl.href,cloneUrl.href,name,name);
    await sql`DROP DATABASE ${sql.id(name)}`.execute(source);
  }
  await source.destroy();
  if (dumpOwned) await unlink(dump);
}
