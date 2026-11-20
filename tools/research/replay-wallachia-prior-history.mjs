import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {access,readFile,writeFile,mkdtemp,unlink,rmdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {createDatabase,sql,IdentityProvisioner,SeriesProvisionRepository,V1DataRepository,prepareReleaseHistory} from '../../packages/db/dist/index.js';
import {IngestionService} from '../../packages/ingestion/dist/index.js';
import {assertIsolatedTarget} from './post-draft-history-replay.mjs';
import {cached,publicInputs,plan,sha,verifyPrior} from './wallachia-prior-replay-inputs.mjs';

const [revision,...extra]=process.argv.slice(2);
const extended=['extended','profiles'].includes(revision);
assert(!extra.length && (revision===undefined || extended || /^r[1-9]\d*$/.test(revision)));
const {priors}=await publicInputs(extended?'extended':'original');
const suffix=revision?'-'+revision:'';
const inventoryPath='.tools/s309-wallachia-replayed-inventory'+suffix+'.json';
const reportPath='.tools/s309-wallachia-replayed-import'+suffix+'.json';
for (const path of [inventoryPath,reportPath]) {
  try {await access(path);}
  catch (error) {if (error.code==='ENOENT') continue; throw error;}
  throw new Error('Replay output already exists: '+path);
}
const sourceUrl=new URL(process.env.DATABASE_URL);
const name='codex_s304_dry_'+randomBytes(8).toString('hex');
const copyUrl=new URL(sourceUrl);
copyUrl.pathname='/'+name;
assertIsolatedTarget(sourceUrl.toString(),copyUrl.toString(),name,name);
const source=createDatabase(sourceUrl.toString());
const pgEnv={...process.env,PGHOST:sourceUrl.hostname,PGPORT:sourceUrl.port||'5432',
  PGDATABASE:decodeURIComponent(sourceUrl.pathname.slice(1)),PGUSER:decodeURIComponent(sourceUrl.username),PGPASSWORD:decodeURIComponent(sourceUrl.password)};
const exec=promisify(execFile);
async function pg(binary,args) {
  try {await exec(resolve('.tools/pgsql/bin',binary+'.exe'),args,{env:pgEnv,windowsHide:true,timeout:240000});}
  catch(error) {throw new Error(binary+' failed: '+error.code);}
}
let clone,created=false,temp,dump;
try {
  const selection=await plan(source,priors);
  const refs={};
  const observations=new Map();
  for (const id of selection.missing) {
    const obs=await cached(id);
    verifyPrior(id,obs,priors);
    observations.set(id,obs);
    refs[id]=obs.source.payloadSha256;
  }
  const leagues=await cached('leagues'),heroes=await cached('heroes');
  const protectedState=async db=>(await sql`SELECT (SELECT count(*) FROM matches)::int AS maps,
  (SELECT count(*) FROM series)::int AS series,(SELECT count(*) FROM provider_ingest_receipts)::int AS receipts,
  (SELECT count(*) FROM v1_model_artifacts)::int AS artifacts,(SELECT count(*) FROM prediction_runs)::int AS predictions`.execute(db)).rows[0];
  const before=await protectedState(source);
  temp=await mkdtemp(resolve('.tools/wallachia-replay-'));
  dump=join(temp,'source.dump');
  await pg('pg_dump',['--format=custom','--no-owner','--file',dump]);
  await sql`CREATE DATABASE ${sql.id(name)} TEMPLATE template0`.execute(source);
  created=true;
  await pg('pg_restore',['--exit-on-error','--no-owner','--dbname',name,dump]);
  clone=createDatabase(copyUrl.toString());
  const actual=(await sql`SELECT current_database() AS name`.execute(clone)).rows[0].name;
  assertIsolatedTarget(sourceUrl.toString(),copyUrl.toString(),name,actual);
  assert.deepEqual(await protectedState(clone),before);
  let profileAudit;
  if (revision==='profiles') {
    const {profileReviews}=await import('./wallachia-profile-history.mjs');
    const {profiles,maps}=await profileReviews();
    const evidence=await readFile('docs/evidence/s3-09-wallachia-numeric-profiles.json');
    assert.equal(sha(evidence),'1920a5762c84f68639b8099b1851c61075c46e56b8c0a598c7ff722d6806fca1');
    const expected=JSON.parse(evidence);
    assert.deepEqual(maps,expected.maps);
    assert.deepEqual(profiles.map(p=>({...p.ref,verified:!!p.review,reason:p.reason})),expected.profiles);
    const identityCounts=async db=>(await sql`SELECT (SELECT count(*) FROM players)::int AS players,
      (SELECT count(*) FROM player_account_evidence)::int AS claims`.execute(db)).rows[0];
    const previous=await identityCounts(source);
    assert.deepEqual(await identityCounts(clone),previous);
    const provisioner=new IdentityProvisioner(clone);
    for (const {review} of profiles.filter(p=>p.review)) {
      const preview=await provisioner.preview(review);
      assert.notEqual(preview.status,'blocked');
      await provisioner.apply(review,preview.fingerprint);
    }
    const resolved=await plan(clone,priors);
    for (const id of maps.filter(id=>resolved.missing.includes(id) && !observations.has(id))) {
      const obs=await cached(id);
      verifyPrior(id,obs,priors);
      observations.set(id,obs);
      refs[id]=obs.source.payloadSha256;
      selection.missing.push(id);
    }
    selection.unbound=resolved.unbound;
    profileAudit={before:previous,after:await identityCounts(clone),accounts:profiles.filter(p=>p.review).map(p=>p.ref.id)};
    assert.deepEqual(await identityCounts(source),previous);
  }
  const importer=new IngestionService(clone,{getHeroes:async()=>heroes,getLeagues:async()=>leagues,
    getMatchSource:async id=>{assert(observations.has(id));return observations.get(id);}});
  const accepted=[], declined=[];
  for (const id of selection.missing) {
    const outcome=await importer.ingest(id);
    if (outcome.status==='accepted') accepted.push(id);
    else declined.push({id,status:outcome.status});
  }
  const repo=new SeriesProvisionRepository(clone);
  const groups=[...new Set(accepted.map(id=>String(JSON.parse(observations.get(id).rawBody).series_id)).filter(k=>/^[1-9]\d*$/.test(k)))].sort();
  const blockedSeries=[];
  let createdSeries=0;
  for (const id of groups) {
    const request={providerSeriesIds:[id],snapshotAt:new Date().toISOString()};
    const preview=await repo.preview(request);
    if (preview.status==='ready') createdSeries+=(await repo.apply(request,preview.fingerprint)).created;
    else blockedSeries.push({id,reasons:preview.groups.flatMap(g=>g.reasons)});
  }
  // The importer resolves the local series link on replay once that native ID exists.
  for (const id of accepted) assert.equal((await importer.ingest(id)).status,'accepted');
  for (const id of accepted) assert.equal((await importer.ingest(id)).duplicate,true);
  const snapshotAt=new Date().toISOString();
  const codePath='tools/research/replay-wallachia-prior-history.mjs';
  const inventory=await new V1DataRepository(clone).exportReleaseInventory({fromAt:'2024-01-01T00:00:00.000Z',
    toAt:snapshotAt,snapshotAt,maxMaps:5000},[{path:codePath,sha256:sha(await readFile(codePath))}]);
  const {history,assessments}=prepareReleaseHistory(inventory);
  const eligible=new Set(history.maps.map(m=>m.matchId));
  const bytes=JSON.stringify(inventory)+'\n';
  const after=await protectedState(clone);
  assert.equal(after.artifacts,before.artifacts);
  assert.equal(after.predictions,before.predictions);
  assert.deepEqual(await protectedState(source),before);
  const report={snapshotAt,before,after,fetchedMapHashes:refs,unboundMaps:selection.unbound,
    sourceSeriesCreated:createdSeries,blockedSeries,accepted,declined,...(profileAudit?{profileAudit}:{}),
    newEligible:accepted.filter(id=>eligible.has(id)),excluded:assessments.filter(a=>accepted.includes(a.matchId)&&!eligible.has(a.matchId)),
    inventory:{path:inventoryPath,sha256:sha(bytes)},workingBusinessWrites:0,targetSeriesScored:0};
  await writeFile(inventoryPath,bytes,{flag:'wx'});
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({requested:selection.missing.length,accepted:accepted.length,eligible:report.newEligible.length,
    declined:declined.length,createdSeries,blockedSeries:blockedSeries.length,historyMaps:history.maps.length}));
} finally {
  await clone?.destroy();
  if (created) {
    assertIsolatedTarget(sourceUrl.toString(),copyUrl.toString(),name,name);
    await sql`DROP DATABASE ${sql.id(name)}`.execute(source);
  }
  await source.destroy();
  if (dump) await unlink(dump).catch(e=>{if(e.code!=='ENOENT') throw e;});
  if (temp) await rmdir(temp);
}
