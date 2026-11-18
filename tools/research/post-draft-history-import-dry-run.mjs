import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDatabase,sql,OutcomeVerifier,SeriesProvisionRepository} from '../../packages/db/dist/index.js';
import {IngestionService} from '../../packages/ingestion/dist/index.js';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
import {buildImportPlan} from './post-draft-history-import-plan.mjs';
import {readImportInventory} from './post-draft-history-import-inventory.mjs';
import {createProjectionReplay,assertIsolatedTarget} from './post-draft-history-replay.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),directory='.tools/s304-history-import-dry-run-r1';
const path=p=>resolve(root,p),save=(p,v)=>writeFile(path(p),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const sources={proposal:'docs/evidence/s3-04-history-import-dry-run-proposal.json',plan:'.tools/s304-history-import-plan.json',
 report:'.tools/s304-history-quota-resume-r1/report.json',capture:'.tools/s304-import-plan-capture.json',selection:'docs/evidence/s3-04-history-import-plan-proposal.json'};
const frozenPaths=['.tools/s304-dataset-final.json','.tools/s304-dataset-capture-final.json','.tools/s304-fit-r1/artifact.json','.tools/s304-eval-r1/report.json'];
const ownPaths=['tools/research/post-draft-history-import-dry-run.mjs','tools/research/post-draft-history-replay.mjs','tools/research/post-draft-history-import-inventory.mjs','tests/node/post-draft-history-replay.test.mjs'];
async function codeFiles(){
 const files=[...ownPaths,'pnpm-lock.yaml'];
 for(const dir of ['packages/db/dist','packages/ingestion/dist','packages/contracts/dist','packages/prediction/dist']){
  for(const name of await readdir(path(dir),{recursive:true}))if(name.endsWith('.js'))files.push((dir+'/'+name).replaceAll('\\','/'));
 }
 return Promise.all(files.sort().map(async p=>({path:p,sha256:sha(await readFile(path(p)))})));
}
async function inputs(){
 const entries=await Promise.all(Object.entries(sources).map(async([k,p])=>[k,await boundedJson(path(p))]));
 const raw=Object.fromEntries(entries),s=Object.fromEntries(entries.map(([k,r])=>[k,r.value]));
 assert.equal(s.proposal.sourcePlanSha256,raw.plan.sha256);
 assert.deepEqual(s.plan.sourceHashes,{proposal:raw.selection.sha256,report:raw.report.sha256,capture:raw.capture.sha256});
 for(const c of s.plan.code)assert.equal(sha(await readFile(path(c.path))),c.sha256,'frozen_plan_code');
 assert.equal(digest(buildImportPlan(s.report,s.selection,s.capture)),digest(s.plan.plan));
 const replay=createProjectionReplay(s.proposal,s.plan.plan,s.report,s.capture);
 return {s,replay,hashes:Object.fromEntries(entries.map(([k,r])=>[k,r.sha256]))};
}
async function fingerprints(db){return db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
 await sql`SET TRANSACTION READ ONLY`.execute(tx);
 const tables=(await sql`SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','pgboss') ORDER BY schemaname,tablename`.execute(tx)).rows,result={};
 for(const {schemaname,tablename} of tables)result[schemaname+'.'+tablename]=(await sql`SELECT count(*)::int count,md5(coalesce(string_agg(h,',' ORDER BY h),'')) hash
  FROM (SELECT md5(to_jsonb(r)::text) h FROM ${sql.table(schemaname+'.'+tablename)} r) q`.execute(tx)).rows[0];
 return result;
});}
async function priorMapFingerprint(db,ids){return db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
 await sql`SET TRANSACTION READ ONLY`.execute(tx);
 const out={};
 for(const table of ['matches','match_players'])out[table]=(await sql`SELECT count(*)::int count,md5(coalesce(string_agg(h,',' ORDER BY h),'')) hash
  FROM (SELECT md5(to_jsonb(r)::text) h FROM ${sql.table(table)} r WHERE ${sql.ref(table==='matches'?'id':'match_id')}::text=ANY(${ids}::text[])) q`.execute(tx)).rows[0];
 return out;
});}
function pgCommand(binary,args,url){
 const bin=process.env.PG_BIN??path('.tools/pgsql/bin'),env={...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password)};
 try{execFileSync(resolve(bin,binary+(process.platform==='win32'?'.exe':'')),args,{env,windowsHide:true,stdio:'pipe',timeout:120000});}
 catch{throw Error('isolated_pg_command_failed_'+binary);}
}
export function validateDryRunResult(result,plan){
 assert.equal(result.status,'PASS');assert.equal(result.isolatedDatabaseDropped,true);
 assert.equal(result.providerHttp,0);assert.equal(result.workingDatabaseWrites,0);assert.equal(result.trainingPerformed,false);
 assert.equal(result.sourceUnchanged,true);assert.equal(result.previousMapsUnchanged,true);assert.equal(result.repeatRowsUnchanged,true);
 const selected=plan.maps.filter(m=>!m.reasons.length).map(m=>m.matchId);
 assert.deepEqual(result.base.map(r=>r.matchId),selected);assert.deepEqual(result.linked.map(r=>r.matchId),selected);assert.deepEqual(result.repeat.map(r=>r.matchId),selected);
 for(const rows of [result.base,result.linked,result.repeat])assert(rows.every(r=>r.status==='accepted'));
 assert(result.repeat.every(r=>r.duplicate));assert.equal(result.series.created,plan.counts.newSeries);
 assert.equal(result.counts.mapsAdded,selected.length);assert.equal(result.counts.playersAdded,selected.length*10);assert.equal(result.counts.teamsAdded,plan.counts.newTeams);
 assert.equal(result.lineage.length,selected.length);
 for(const m of plan.maps.filter(m=>!m.reasons.length)){
  const l=result.lineage.find(r=>r.matchId===m.matchId);assert(l);assert.equal(digest(l.originalSource),digest(m.source));assert.equal(l.projectionSha256,m.projectionSha256);
  assert(l.receipts.length>=2);assert(l.receipts.every(r=>r.payload_sha256===l.projectionSha256&&r.known_at===null&&r.adapter_version===m.replay.adapterVersion));
 }
 const wholeIds=[...new Set(plan.groups.filter(g=>!g.reasons.length).flatMap(g=>g.knownMapIds))].sort();
 assert.deepEqual(result.outcomes.map(o=>o.matchId).sort(),wholeIds);assert(result.outcomes.every(o=>o.status==='verified'&&o.seriesId!==null));
 for(const g of plan.groups.filter(g=>!g.reasons.length)){
  const mapping=result.series.mappings.find(m=>m.providerSeriesId===g.sourceSeriesId);assert(mapping);assert.deepEqual([...mapping.mapIds].sort(),[...g.knownMapIds].sort());
  assert(result.outcomes.filter(o=>g.knownMapIds.includes(o.matchId)).every(o=>o.seriesId===mapping.seriesId));
 }
}
async function run(){
 const {s,replay,hashes}=await inputs(),plan=s.plan.plan;
 const url=new URL(process.env.DATABASE_URL),name='codex_s304_dry_'+randomBytes(8).toString('hex'),copyUrl=new URL(url);copyUrl.pathname='/'+name;
 assertIsolatedTarget(url.toString(),copyUrl.toString(),name,name);
 // An existing run is never overwritten or reused, including a failed run.
 await mkdir(path(directory));
 const manifest={format:'post-draft-import-dry-run-v1',registeredAt:new Date().toISOString(),sourceHashes:hashes,code:await codeFiles(),
  frozen:await Promise.all(frozenPaths.map(async p=>({path:p,sha256:sha(await readFile(path(p)))}))),isolatedDatabase:name,planFingerprint:plan.fingerprint};
 await save(directory+'/manifest.json',manifest);
 globalThis.fetch=async()=>{throw Error('provider_http_forbidden');};
 const source=createDatabase(url.toString());let copy,created=false,baseline,result,phase='source_preflight',failure=false;
 try{
  baseline=await fingerprints(source);await save(directory+'/source-before.json',baseline);
  assert.deepEqual(await readImportInventory(source,s.capture),s.capture,'planning_references_changed');
  const dump=path(directory+'/private-source.dump');pgCommand('pg_dump',['--format=custom','--no-owner','--file',dump],url);
  phase='clone_create';await sql`CREATE DATABASE ${sql.id(name)} TEMPLATE template0`.execute(source);created=true;
  pgCommand('pg_restore',['--exit-on-error','--no-owner','--dbname',name,dump],url);
  copy=createDatabase(copyUrl.toString());
  assertIsolatedTarget(url.toString(),copyUrl.toString(),name,(await sql`SELECT current_database() AS name`.execute(copy)).rows[0].name);
  assert.deepEqual(await fingerprints(copy),baseline,'clone_rows_mismatch');
  assert.deepEqual(await readImportInventory(copy,s.capture),s.capture,'clone_references_mismatch');
  const priorIds=s.capture.maps.map(m=>m.id),prior=await priorMapFingerprint(copy,priorIds),service=new IngestionService(copy,replay.provider),base=[];
  phase='base_import';
  for(const id of s.proposal.mapIds){const r=await service.ingest(id);base.push(r);assert.equal(r.status,'accepted');assert.equal(r.duplicate,false);}
  await save(directory+'/base.json',base);
  const request={providerSeriesIds:plan.groups.filter(g=>!g.reasons.length).map(g=>g.sourceSeriesId),snapshotAt:new Date().toISOString()};
  const repository=new SeriesProvisionRepository(copy),preview=await repository.preview(request);
  await save(directory+'/series-preview.json',preview);assert.equal(preview.status,'ready','series_preview_not_ready');
  for(const g of plan.groups.filter(g=>!g.reasons.length))assert.deepEqual([...preview.groups.find(p=>p.providerSeriesId===g.sourceSeriesId).mapIds].sort(),[...g.knownMapIds].sort());
  phase='series_provision';const series=await repository.apply(request,preview.fingerprint);assert.equal(series.created,plan.counts.newSeries);
  assert.equal((await repository.apply(request,preview.fingerprint)).status,'already_applied');
  phase='series_link';const linked=[];for(const id of s.proposal.mapIds){const r=await service.ingest(id);linked.push(r);assert.equal(r.status,'accepted');}
  const outcomes=[],verifier=new OutcomeVerifier(copy),snapshotAt=new Date().toISOString();
  for(const id of [...new Set(plan.groups.filter(g=>!g.reasons.length).flatMap(g=>g.knownMapIds))])outcomes.push(await verifier.verifyProMap({matchId:id,snapshotAt,teamASide:'radiant'}));
  assert(outcomes.every(o=>o.status==='verified'&&o.seriesId!==null),'whole_series_outcomes');
  const lineage=[];
  for(const origin of replay.lineage){
   const receipts=(await sql`SELECT id::text,adapter_version,payload_sha256,known_at,fetched_at,status FROM provider_ingest_receipts WHERE provider_match_id=${origin.matchId} ORDER BY id`.execute(copy)).rows;
   lineage.push({...origin,receipts});
   const selected=plan.maps.find(m=>m.matchId===origin.matchId),actual=(await sql`SELECT player_slot AS slot,source_account_id::text AS "accountId",player_id::text AS "playerId",hero_id AS "heroId" FROM match_players WHERE match_id=${origin.matchId} ORDER BY player_slot`.execute(copy)).rows;
   assert.deepEqual(actual,selected.members.map(({slot,accountId,playerId,heroId})=>({slot,accountId,playerId,heroId})).sort((a,b)=>a.slot-b.slot));
   const row=(await sql`SELECT m.patch_id,m.map_number,m.radiant_win,m.duration_seconds,m.started_at,a.opendota_team_id::text AS radiant,b.opendota_team_id::text AS dire FROM matches m JOIN teams a ON a.id=m.radiant_team_id JOIN teams b ON b.id=m.dire_team_id WHERE m.id=${origin.matchId}`.execute(copy)).rows[0];
   const p=s.report.rows.find(r=>r.matchId===origin.matchId).receipt.projection;
   assert.equal(row.patch_id,null);assert.equal(row.map_number,null);assert.equal(row.radiant_win,p.radiant_win);assert.equal(row.duration_seconds,p.duration);
   assert.equal(row.started_at.toISOString(),new Date(p.start_time*1000).toISOString());assert.equal(row.radiant,String(p.radiant_team_id));assert.equal(row.dire,String(p.dire_team_id));
  }
  phase='idempotency';const once=await fingerprints(copy),repeat=[];
  for(const id of s.proposal.mapIds){const r=await service.ingest(id);repeat.push(r);assert(r.duplicate);}
  assert.deepEqual(await fingerprints(copy),once,'repeat_rows_changed');assert.deepEqual(await priorMapFingerprint(copy,priorIds),prior,'old_maps_changed');
  const allowed=new Set(['teams','series','series_provision_batches','matches','match_players','provider_ingest_receipts','match_source_snapshots','match_draft_source_observations','match_field_observations','match_quality_assessments'].map(t=>'public.'+t));
  const changed=Object.keys(baseline).filter(t=>digest(baseline[t])!==digest(once[t]));for(const t of changed)assert(allowed.has(t),'unexpected_table_change');
  assert.deepEqual(await fingerprints(source),baseline,'working_rows_changed');
  for(const f of manifest.frozen)assert.equal(sha(await readFile(path(f.path))),f.sha256,'frozen_artifact_changed');
  result={status:'PASS',checkedAt:new Date().toISOString(),base,linked,repeat,series,outcomes,lineage,changedTables:changed,
   counts:{mapsAdded:once['public.matches'].count-baseline['public.matches'].count,playersAdded:once['public.match_players'].count-baseline['public.match_players'].count,
    teamsAdded:once['public.teams'].count-baseline['public.teams'].count,verifiedOutcomes:outcomes.length},
   backupSha256:sha(await readFile(dump)),sourceUnchanged:true,previousMapsUnchanged:true,repeatRowsUnchanged:true,
   providerHttp:0,workingDatabaseWrites:0,trainingPerformed:false,deployable:false,isolatedDatabaseDropped:false};
  await save(directory+'/clone-after.json',once);
 }catch{failure=true;result={status:'FAIL',phase,isolatedDatabaseDropped:false,providerHttp:0,workingDatabaseWrites:0};}
 finally{
  await copy?.destroy();
  if(created){assertIsolatedTarget(url.toString(),copyUrl.toString(),name,name);await sql`DROP DATABASE ${sql.id(name)}`.execute(source);result.isolatedDatabaseDropped=true;}
  if(baseline){const final=await fingerprints(source);await save(directory+'/source-after.json',final);result.sourceUnchanged=digest(final)===digest(baseline);if(!result.sourceUnchanged)failure=true;}
  await source.destroy();
 }
 if(!failure)validateDryRunResult(result,plan);
 await save(directory+'/report.json',result);
 const names=['manifest.json','report.json','source-before.json','source-after.json',...(!failure?['base.json','series-preview.json','clone-after.json']:[])];
 await save(directory+'/seal.json',await Promise.all(names.map(async name=>({name,sha256:sha(await readFile(path(directory+'/'+name)))}))));
 if(failure)throw Error('dry_run_failed_'+result.phase);
 console.log(JSON.stringify({status:result.status,counts:result.counts,sourceUnchanged:result.sourceUnchanged,isolatedDatabaseDropped:result.isolatedDatabaseDropped}));
}
async function verify(){
 const {s,hashes}=await inputs(),manifest=(await boundedJson(path(directory+'/manifest.json'))).value,report=(await boundedJson(path(directory+'/report.json'))).value;
 assert.deepEqual(hashes,manifest.sourceHashes);assert.deepEqual(await codeFiles(),manifest.code);
 for(const f of manifest.frozen)assert.equal(sha(await readFile(path(f.path))),f.sha256);
 for(const f of (await boundedJson(path(directory+'/seal.json'))).value){assert(/^[a-z-]+\.json$/.test(f.name));assert.equal(sha(await readFile(path(directory+'/'+f.name))),f.sha256);}
 assert.equal((await boundedJson(path(directory+'/source-before.json'))).sha256,(await boundedJson(path(directory+'/source-after.json'))).sha256);
 validateDryRunResult(report,s.plan.plan);console.log(JSON.stringify({status:'PASS',mode:'offline_verify',counts:report.counts}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const mode=process.argv[2];
 Promise.resolve().then(()=>{assert.equal(process.argv.length,3);assert(['run','verify'].includes(mode));return mode==='run'?run():verify();})
 .catch(error=>{console.error('Пробная загрузка отклонена; проверьте локальный отчёт. '+(error.message?.startsWith('dry_run_failed_')?error.message:''));process.exitCode=1;});
}
