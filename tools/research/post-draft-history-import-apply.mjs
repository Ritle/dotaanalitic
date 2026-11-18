import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDatabase,sql,OutcomeVerifier,SeriesProvisionRepository,PredictionModelRegistry} from '../../packages/db/dist/index.js';
import {IngestionService} from '../../packages/ingestion/dist/index.js';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
import {buildImportPlan} from './post-draft-history-import-plan.mjs';
import {readImportInventory} from './post-draft-history-import-inventory.mjs';
import {createProjectionReplay,assertIsolatedTarget} from './post-draft-history-replay.mjs';
import {validateApplyScope,validateCurrentReferences,validateApplyResult,validateTableChanges} from './post-draft-history-apply-policy.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),path=p=>resolve(root,p);
const directories={run:'.tools/s304-history-import-apply-r1',rehearse:'.tools/s304-history-import-apply-rehearsal-r2'};
const json=v=>JSON.stringify(v,null,2)+'\n',save=(p,v)=>writeFile(path(p),json(v),{flag:'wx'});
const sources={proposal:'docs/evidence/s3-04-history-import-apply-proposal.json',plan:'.tools/s304-history-import-plan.json',
 details:'.tools/s304-history-quota-resume-r1/report.json',capture:'.tools/s304-import-plan-capture.json',selection:'docs/evidence/s3-04-history-import-plan-proposal.json',
 dryProposal:'docs/evidence/s3-04-history-import-dry-run-proposal.json',dryManifest:'.tools/s304-history-import-dry-run-r1/manifest.json',dryReport:'.tools/s304-history-import-dry-run-r1/report.json'};
const frozenPaths=['.tools/s304-dataset-final.json','.tools/s304-dataset-capture-final.json','.tools/s304-fit-r1/artifact.json','.tools/s304-eval-r1/report.json'];
const ownPaths=['tools/research/post-draft-history-import-apply.mjs','tools/research/post-draft-history-apply-policy.mjs',
 'tests/node/post-draft-history-apply.test.mjs','packages/db/migrations/057_history_projection_import_audit.sql'];
async function codeFiles(){
 const files=[...ownPaths,'pnpm-lock.yaml'];
 for(const dir of ['packages/db/dist','packages/ingestion/dist','packages/contracts/dist','packages/prediction/dist'])
  for(const name of await readdir(path(dir),{recursive:true}))if(name.endsWith('.js'))files.push((dir+'/'+name).replaceAll('\\','/'));
 return Promise.all(files.sort().map(async p=>({path:p,sha256:sha(await readFile(path(p)))})));
}
async function inputs(){
 const raw=Object.fromEntries(await Promise.all(Object.entries(sources).map(async([k,p])=>[k,await boundedJson(path(p))]))),s=Object.fromEntries(Object.entries(raw).map(([k,r])=>[k,r.value]));
 assert.equal(s.proposal.sourcePlanSha256,raw.plan.sha256);assert.equal(s.proposal.dryRunManifestSha256,raw.dryManifest.sha256);assert.equal(s.proposal.dryRunReportSha256,raw.dryReport.sha256);
 assert.equal(s.dryReport.status,'PASS');assert.equal(s.dryReport.isolatedDatabaseDropped,true);
 assert.deepEqual(s.plan.sourceHashes,{proposal:raw.selection.sha256,report:raw.details.sha256,capture:raw.capture.sha256});
 for(const c of s.plan.code)assert.equal(sha(await readFile(path(c.path))),c.sha256,'frozen_plan_code');
 assert.equal(digest(buildImportPlan(s.details,s.selection,s.capture)),digest(s.plan.plan));validateApplyScope(s.proposal,s.plan.plan);
 // The archived dry-run contract validates byte projections only. Working authorization
 // is independently checked above; its isolated-database execution guard is not reused.
 const replay=createProjectionReplay(s.dryProposal,s.plan.plan,s.details,s.capture);
 replay.lineage=replay.lineage.map(l=>({...l,storage:'immutable_working_import_manifest'}));
 return {s,replay,hashes:Object.fromEntries(Object.entries(raw).map(([k,r])=>[k,r.sha256]))};
}
async function fingerprintRows(tx){
 const tables=(await sql`SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','pgboss') ORDER BY schemaname,tablename`.execute(tx)).rows,result={};
 for(const {schemaname,tablename} of tables)result[schemaname+'.'+tablename]=(await sql`SELECT count(*)::int count,md5(coalesce(string_agg(h,',' ORDER BY h),'')) hash
  FROM (SELECT md5(to_jsonb(r)::text) h FROM ${sql.table(schemaname+'.'+tablename)} r) q`.execute(tx)).rows[0];
 return result;
}
async function fingerprints(db){return db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
 await sql`SET TRANSACTION READ ONLY`.execute(tx);return fingerprintRows(tx);
});}
async function priorMaps(db,ids){
 const out={};for(const table of ['matches','match_players'])out[table]=(await sql`SELECT count(*)::int count,md5(coalesce(string_agg(h,',' ORDER BY h),'')) hash
  FROM (SELECT md5(to_jsonb(r)::text) h FROM ${sql.table(table)} r WHERE ${sql.ref(table==='matches'?'id':'match_id')}::text=ANY(${ids}::text[])) q`.execute(db)).rows[0];
 return out;
}
function pgCommand(binary,args,url){
 const bin=process.env.PG_BIN??path('.tools/pgsql/bin'),env={...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password)};
 try{return execFileSync(resolve(bin,binary+(process.platform==='win32'?'.exe':'')),args,{env,windowsHide:true,stdio:'pipe',timeout:120000});}
 catch{throw Error('pg_command_failed_'+binary);}
}
async function revalidate(db,s){const current=await readImportInventory(db,s.capture);return {current,review:validateCurrentReferences(s.capture,current,s.plan.plan,buildImportPlan(s.details,s.selection,current))};}
async function perform(db,manifest,s,replay,dir,baseline){
 const plan=s.plan.plan,prior=await priorMaps(db,s.capture.maps.map(m=>m.id)),modelBefore=await new PredictionModelRegistry(db).readiness();
 const manifestText=json(manifest),manifestSha=sha(manifestText);
 await sql`INSERT INTO history_projection_imports(id,manifest_text,manifest_sha256) VALUES(${manifest.id}::uuid,${manifestText},${manifestSha})`.execute(db);
 const registered=await fingerprints(db);await save(dir+'/registered.json',registered);
 const service=new IngestionService(db,replay.provider),base=[];
 for(const id of s.proposal.mapIds){const r=await service.ingest(id);await save(dir+'/base-'+id+'.json',r);base.push(r);assert.equal(r.status,'accepted');assert.equal(r.duplicate,false);}
 const request={providerSeriesIds:plan.groups.filter(g=>!g.reasons.length).map(g=>g.sourceSeriesId),snapshotAt:new Date().toISOString()};
 const repo=new SeriesProvisionRepository(db),preview=await repo.preview(request);await save(dir+'/series-preview.json',preview);assert.equal(preview.status,'ready');
 for(const g of plan.groups.filter(g=>!g.reasons.length))assert.deepEqual([...preview.groups.find(p=>p.providerSeriesId===g.sourceSeriesId).mapIds].sort(),[...g.knownMapIds].sort());
 const series=await repo.apply(request,preview.fingerprint);await save(dir+'/series.json',series);assert.equal(series.created,plan.counts.newSeries);
 assert.equal((await repo.apply(request,preview.fingerprint)).status,'already_applied');
 const linked=[];for(const id of s.proposal.mapIds){const r=await service.ingest(id);await save(dir+'/linked-'+id+'.json',r);linked.push(r);assert.equal(r.status,'accepted');}
 const outcomes=[],verifier=new OutcomeVerifier(db),snapshotAt=new Date().toISOString();
 for(const id of [...new Set(plan.groups.filter(g=>!g.reasons.length).flatMap(g=>g.knownMapIds))])outcomes.push(await verifier.verifyProMap({matchId:id,snapshotAt,teamASide:'radiant'}));
 const lineage=[];
 for(const origin of replay.lineage){
  const receipts=(await sql`SELECT id::text,adapter_version,payload_sha256,known_at,fetched_at,status FROM provider_ingest_receipts WHERE provider_match_id=${origin.matchId} ORDER BY id`.execute(db)).rows;
  lineage.push({...origin,receipts});
  const selected=plan.maps.find(m=>m.matchId===origin.matchId),actual=(await sql`SELECT player_slot AS slot,source_account_id::text AS "accountId",player_id::text AS "playerId",hero_id AS "heroId" FROM match_players WHERE match_id=${origin.matchId} ORDER BY player_slot`.execute(db)).rows;
  assert.deepEqual(actual,selected.members.map(({slot,accountId,playerId,heroId})=>({slot,accountId,playerId,heroId})).sort((a,b)=>a.slot-b.slot));
  const row=(await sql`SELECT m.patch_id,m.map_number,m.radiant_win,m.duration_seconds,m.started_at,a.opendota_team_id::text AS radiant,b.opendota_team_id::text AS dire FROM matches m JOIN teams a ON a.id=m.radiant_team_id JOIN teams b ON b.id=m.dire_team_id WHERE m.id=${origin.matchId}`.execute(db)).rows[0];
  const p=s.details.rows.find(r=>r.matchId===origin.matchId).receipt.projection;
  assert.equal(row.patch_id,null);assert.equal(row.map_number,null);assert.equal(row.radiant_win,p.radiant_win);assert.equal(row.duration_seconds,p.duration);
  assert.equal(row.started_at.toISOString(),new Date(p.start_time*1000).toISOString());assert.equal(row.radiant,String(p.radiant_team_id));assert.equal(row.dire,String(p.dire_team_id));
 }
 const once=await fingerprints(db),repeat=[];
 for(const id of s.proposal.mapIds){const r=await service.ingest(id);repeat.push(r);assert(r.duplicate);}
 assert.deepEqual(await fingerprints(db),once,'repeat_rows_changed');assert.deepEqual(await priorMaps(db,s.capture.maps.map(m=>m.id)),prior,'old_maps_changed');
 const changed=validateTableChanges(registered,once);assert.deepEqual(await new PredictionModelRegistry(db).readiness(),modelBefore,'model_changed');
 for(const f of manifest.frozen)assert.equal(sha(await readFile(path(f.path))),f.sha256,'frozen_artifact_changed');
 assert.deepEqual(await codeFiles(),manifest.code,'code_changed_during_import');
 const result={status:'PASS',checkedAt:new Date().toISOString(),mode:manifest.mode,importId:manifest.id,manifestSha256:manifestSha,
  base,linked,repeat,series,outcomes,lineage,changedTables:changed,
  counts:{mapsAdded:once['public.matches'].count-baseline['public.matches'].count,playersAdded:once['public.match_players'].count-baseline['public.match_players'].count,
   teamsAdded:once['public.teams'].count-baseline['public.teams'].count,verifiedOutcomes:outcomes.length,seriesCreated:series.created},
  backupSha256:manifest.backupSha256,backupVerified:true,previousMapsUnchanged:true,unrelatedRowsUnchanged:true,repeatRowsUnchanged:true,
  frozenArtifactsUnchanged:true,providerHttp:0,trainingRuns:0,modelActivations:0,model:modelBefore};
 validateApplyResult(result,s.proposal,plan);await save(dir+'/imported.json',once);
 const text=json(result);await sql`INSERT INTO history_projection_import_completions(import_id,report_text,report_sha256) VALUES(${manifest.id}::uuid,${text},${sha(text)})`.execute(db);
 await save(dir+'/report.json',result);
 const after=await fingerprints(db);await save(dir+'/after.json',after);
 const expected={...once,'public.history_projection_import_completions':after['public.history_projection_import_completions']};assert.deepEqual(after,expected,'post_completion_rows_changed');
 return result;
}
async function seal(dir){const names=(await readdir(path(dir))).filter(n=>n.endsWith('.json')&&n!=='seal.json').sort();await save(dir+'/seal.json',await Promise.all(names.map(async name=>({name,sha256:sha(await readFile(path(dir+'/'+name)))}))));}
async function run(mode){
 const {s,replay,hashes}=await inputs();globalThis.fetch=async()=>{throw Error('provider_http_forbidden');};
 if(mode==='run')await verify('rehearse',false);
 const dir=directories[mode],url=new URL(process.env.DATABASE_URL);assert(['postgresql:','postgres:'].includes(url.protocol));assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
 assert(!/^codex_/.test(decodeURIComponent(url.pathname.slice(1))),'working_database_required');
 await mkdir(path(dir));const db=createDatabase(url.toString()),copyName='codex_s304_dry_'+randomBytes(8).toString('hex'),copyUrl=new URL(url);copyUrl.pathname='/'+copyName;
 let clone,created=false,phase='preflight',result;
 try{
  assert.equal((await sql`SELECT current_database() name`.execute(db)).rows[0].name,decodeURIComponent(url.pathname.slice(1)));
  if(mode==='run'){
   const other=(await sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()`.execute(db)).rows;
   assert.equal(other.length,0,'stop_api_and_workers_before_apply');
  }
  const preflight=await revalidate(db,s);await save(dir+'/references.json',preflight);
  phase='backup';const dump=path(dir+'/private-before.dump');
  // Fingerprints and dump share one exported MVCC snapshot even if a live cache
  // refresh commits while the archive is being written. Keep its owner tx open.
  const sourceBefore=await db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
   await sql`SET TRANSACTION READ ONLY`.execute(tx);
   const snapshot=(await sql`SELECT pg_export_snapshot() snapshot`.execute(tx)).rows[0].snapshot;
   const rows=await fingerprintRows(tx);await save(dir+'/source-before.json',rows);
   pgCommand('pg_dump',['--format=custom','--no-owner','--snapshot',snapshot,'--file',dump],url);return rows;
  });
  pgCommand('pg_restore',['--list',dump],url);
  phase='backup_restore';assertIsolatedTarget(url.toString(),copyUrl.toString(),copyName,copyName);
  await sql`CREATE DATABASE ${sql.id(copyName)} TEMPLATE template0`.execute(db);created=true;
  pgCommand('pg_restore',['--exit-on-error','--no-owner','--dbname',copyName,dump],url);clone=createDatabase(copyUrl.toString());
  const restored=await fingerprints(clone);await save(dir+'/backup-restored.json',restored);assert.deepEqual(restored,sourceBefore,'backup_rows_mismatch');
  if(mode==='rehearse'){
   execFileSync(process.execPath,[path('scripts/migrate.mjs')],{env:{...process.env,DATABASE_URL:copyUrl.toString()},stdio:'pipe',windowsHide:true});
  }
  const target=mode==='run'?db:clone;await revalidate(target,s);
  const baseline=await fingerprints(target);assert(baseline['public.history_projection_imports'],'migration_057_required');await save(dir+'/before.json',baseline);
  if(mode==='run')assert.deepEqual(await fingerprints(db),sourceBefore,'source_changed_during_backup');
  const manifest={format:'post-draft-working-import-v1',id:randomUUID(),registeredAt:new Date().toISOString(),mode,sourceHashes:hashes,
   code:await codeFiles(),frozen:await Promise.all(frozenPaths.map(async p=>({path:p,sha256:sha(await readFile(path(p)))}))),
   planFingerprint:s.plan.plan.fingerprint,scope:s.proposal.mapIds,referenceReview:preflight.review,lineage:replay.lineage,
   backupSha256:sha(await readFile(dump)),backupRestoreRowsVerified:true,targetDatabase:mode==='run'?decodeURIComponent(url.pathname.slice(1)):copyName};
  await save(dir+'/manifest.json',manifest);phase='import';result=await perform(target,manifest,s,replay,dir,baseline);
  if(mode==='rehearse'){
   const sourceAfter=await fingerprints(db);await save(dir+'/source-after.json',sourceAfter);
   for(const t of ['public.matches','public.match_players','public.prediction_runs','public.v1_runtime_snapshots','public.live_lineup_estimates'])assert.deepEqual(sourceBefore[t],sourceAfter[t],'source_data_changed');
  }
 }catch(error){await save(dir+'/failure.json',{status:'FAIL',phase,checkedAt:new Date().toISOString(),attemptedMapFiles:await readdir(path(dir)).then(files=>files.filter(f=>f.startsWith('base-'))),
   reason:error.code==='ERR_ASSERTION'?String(error.message).split('\n')[0]:'operation_failed',automaticRollbackPerformed:false});throw Error('working_import_failed_'+phase);}
 finally{await clone?.destroy();if(created){assertIsolatedTarget(url.toString(),copyUrl.toString(),copyName,copyName);await sql`DROP DATABASE ${sql.id(copyName)}`.execute(db);}await db.destroy();}
 await save(dir+'/cleanup.json',{temporaryDatabaseDropped:true});await seal(dir);
 console.log(JSON.stringify({status:'PASS',mode,counts:result.counts,providerHttp:0,trainingRuns:0,modelActivations:0}));
}
async function verify(mode,withDb){
 const dir=directories[mode],{s,hashes}=await inputs(),manifest=(await boundedJson(path(dir+'/manifest.json'))).value,report=(await boundedJson(path(dir+'/report.json'))).value;
 assert.equal(manifest.mode,mode);assert.deepEqual(hashes,manifest.sourceHashes);assert.deepEqual(await codeFiles(),manifest.code);
 assert.deepEqual(manifest.scope,s.proposal.mapIds);assert.equal(manifest.planFingerprint,s.plan.plan.fingerprint);
 assert.equal(report.manifestSha256,sha(await readFile(path(dir+'/manifest.json'))));assert.equal(report.backupSha256,manifest.backupSha256);
 for(const f of manifest.frozen)assert.equal(sha(await readFile(path(f.path))),f.sha256);
 for(const f of (await boundedJson(path(dir+'/seal.json'))).value){assert(/^[a-z0-9-]+\.json$/.test(f.name));assert.equal(sha(await readFile(path(dir+'/'+f.name))),f.sha256);}
 assert.equal((await boundedJson(path(dir+'/cleanup.json'))).value.temporaryDatabaseDropped,true);validateApplyResult(report,s.proposal,s.plan.plan);
 const before=(await boundedJson(path(dir+'/registered.json'))).value,after=(await boundedJson(path(dir+'/imported.json'))).value;assert.deepEqual(validateTableChanges(before,after),report.changedTables);
 if(withDb){assert.equal(mode,'run');const db=createDatabase(process.env.DATABASE_URL);try{
  const row=(await sql`SELECT b.manifest_text,b.manifest_sha256,c.report_text,c.report_sha256 FROM history_projection_imports b JOIN history_projection_import_completions c ON c.import_id=b.id WHERE b.id=${manifest.id}::uuid`.execute(db)).rows[0];assert(row);
  assert.equal(row.manifest_text,await readFile(path(dir+'/manifest.json'),'utf8'));assert.equal(row.manifest_sha256,sha(row.manifest_text));
  assert.equal(row.report_text,await readFile(path(dir+'/report.json'),'utf8'));assert.equal(row.report_sha256,sha(row.report_text));
  for(const l of report.lineage)for(const r of l.receipts){const actual=(await sql`SELECT provider_match_id,adapter_version,payload_sha256,known_at FROM provider_ingest_receipts WHERE id=${r.id}::bigint`.execute(db)).rows[0];
   assert(actual);assert.equal(actual.provider_match_id,l.matchId);assert.equal(actual.payload_sha256,l.projectionSha256);assert.equal(actual.adapter_version,l.adapterVersion);assert.equal(actual.known_at,null);}
 }finally{await db.destroy();}}
 return {status:'PASS',mode:withDb?'verify_db':'offline_verify',counts:report.counts};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(async()=>{assert.equal(process.argv.length,3);const mode=process.argv[2];assert(['run','rehearse','verify','verify-rehearsal','verify-db'].includes(mode));
  if(['run','rehearse'].includes(mode))await run(mode);else console.log(JSON.stringify(await verify(mode==='verify-rehearsal'?'rehearse':'run',mode==='verify-db')));
 }).catch(e=>{console.error('Импорт не завершён: '+(e.message?.startsWith('working_import_failed_')?e.message:'проверка входов, состояния или неизменности не пройдена')+'. См. локальные отчёты; автоматический откат не выполнялся.');process.exitCode=1;});
}
