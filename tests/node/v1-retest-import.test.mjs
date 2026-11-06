import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {retestImportFixture} from '../helpers/retest-import.mjs';
import {closedRetestHeader,retestSourceManifest,buildRetestImport,retestImportProvider,reconcileRetestImport,readRetestImportPlan,sha} from '../../scripts/lib/v1-retest-import.mjs';
import {executeRetestImportStep} from '../../scripts/lib/v1-retest-import-step.mjs';
import {readRetestState,captureRetestBatch} from '../../scripts/lib/v1-retest-store.mjs';
import {RetestImportConfigSchema,RetestImportManifestSchema} from '../../packages/contracts/dist/v1-retest-import.js';
import {HistoricalImportConfigSchema} from '../../packages/contracts/dist/v1-historical-import.js';
import {hash} from '../../scripts/lib/v1-historical-collection.mjs';
import {playerHistoryQuery} from '../../packages/ingestion/dist/player-history.js';
const planRef={path:'synthetic-plan.json',sha256:'e'.repeat(64)};
test('open collections are rejected before reading config, making an output, DB access or network',async()=>{
 const f=await retestImportFixture();try{
  await assert.rejects(closedRetestHeader(f.root,f.ctx.storeSha),/collection_not_closed/);
  const output=join(f.root,'should-not-exist.json'),r=spawnSync(process.execPath,['scripts/import-v1-retest.mjs','manifest',f.root,f.ctx.storeSha,output],{encoding:'utf8',env:{...process.env,DATABASE_URL:'postgres://unused.invalid/no_connection'}});
  assert.equal(r.status,1);const error=JSON.parse(r.stderr.trim());assert.equal(error.code,'RETEST_IMPORT_COLLECTION_NOT_CLOSED');assert.equal(error.writesAttempted,false);
  await assert.rejects(readFile(output),{code:'ENOENT'});assert(!r.stderr.includes('unused.invalid'));
 }finally{await f.dispose();}
});
test('v2 config and manifest stay versioned; invalid or duplicate file entries fail validation',()=>{
 const ref={path:'synthetic.json',sha256:'a'.repeat(64)},v2={schemaVersion:2,collection:{directory:'synthetic-store',sha256:ref.sha256},sourceManifest:ref,heroes:ref,registry:ref,profiles:[]};
 assert(RetestImportConfigSchema.safeParse(v2).success);assert(!HistoricalImportConfigSchema.safeParse(v2).success);assert(!RetestImportConfigSchema.safeParse({...v2,schemaVersion:1}).success);
 const m={schemaVersion:2,format:'retest-import-sources-v2',collectionSha256:ref.sha256,closureSha256:ref.sha256,configSha256:ref.sha256,protocolFingerprint:ref.sha256,stateFingerprint:ref.sha256,files:[],fingerprint:ref.sha256};
 const row={directory:'outcomes',name:'map-1.1.json',sha256:ref.sha256};assert(!RetestImportManifestSchema.safeParse({...m,files:[row,row]}).success);
 assert(!RetestImportManifestSchema.safeParse({...m,files:[{...row,name:'../secret.json'}]}).success);
});
test('closed journal produces a stable manifest and immutable plan with current numeric identities',async()=>{
 const f=await retestImportFixture();try{
  const state=await f.close();assert.equal(await closedRetestHeader(f.root,f.ctx.storeSha),f.root);
  const a=await retestSourceManifest(f.ctx,state),b=await retestSourceManifest(f.ctx,state);assert.deepEqual(a,b);
  assert.equal(a.files.length,10);assert.equal(a.closureSha256,sha(await readFile(join(f.root,'closure.json'))));
  const one=await f.prepare(),two=await f.prepare();assert.deepEqual(one.plan,two.plan);assert.equal(one.plan.format,'v1-retest-import-plan-v2');
  assert.equal(one.plan.maps.length,2);assert.equal(one.plan.accounts.length,10);assert.equal(one.plan.identityReviews.length,10);
  assert.equal(one.plan.identityReviews[0].source.knownAt,f.at);assert.equal(one.plan.collectionReport.rows.length,2);
  assert.equal(one.plan.evaluationPerformed,false);assert.equal(one.plan.deployable,false);assert.equal(one.plan.collectionReport.metrics,null);
  const r=await executeRetestImportStep(one,null,'verify',join(f.root,'verify'),planRef);assert.equal(r.report.writesAttempted,false);assert.equal(r.report.providerRequests,0);
  await assert.rejects(executeRetestImportStep(one,null,'verify',join(f.root,'verify'),planRef),{code:'EEXIST'});
 }finally{await f.dispose();}
});
test('changed journal source is rejected even if its local fingerprint is rehashed',async()=>{
 const f=await retestImportFixture();try{
  await f.close();const p=join(f.root,'outcomes','map-100000001.1.json'),value=JSON.parse(await readFile(p,'utf8'));
  value.code='changed';const {fingerprint,...body}=value;value.fingerprint=hash(body);await writeFile(p,JSON.stringify(value));
  await assert.rejects(readRetestState(f.ctx),/capture_binding|closure_binding/);
 }finally{await f.dispose();}
});
test('manifest captures attempt/run/recovery history and refuses incomplete pending files',async()=>{
 const f=await retestImportFixture();try{
  const state=await f.close(),a=await retestSourceManifest(f.ctx,state);
  await writeFile(join(f.root,'recoveries','00000000-0000-4000-8000-000000000001.json'),'{}');
  assert.notEqual((await retestSourceManifest(f.ctx,state)).fingerprint,a.fingerprint);
  await writeFile(join(f.root,'outcomes','map-1.1.json.pending'),'{');await assert.rejects(retestSourceManifest(f.ctx,state),/source_inventory/);
 }finally{await f.dispose();}
});
test('missing numeric proof is explicit; provider serves only captured reviewed sources',async()=>{
 const f=await retestImportFixture();try{
  await f.close();f.sources.registry=f.obs('/proPlayers',[]);const inputs=await f.prepare();assert.equal(inputs.plan.unresolvedProfiles.length,10);
  const p=retestImportProvider(inputs);assert.equal((await p.getMatchSource('100000001')).source.endpoint,'/matches/100000001');await assert.rejects(p.getMatchSource('999'),/outside_plan/);
 }finally{await f.dispose();}
});
test('deadline closure admits an import plan with retained missing targets, never a fabricated complete dataset',async()=>{
 const f=await retestImportFixture();try{
  f.setTime(f.ctx.plan.collection.collectionDeadline);await captureRetestBatch(f.ctx,'targets',f.provider);const inputs=await f.prepare();
  assert.equal(inputs.plan.maps.length,0);assert.equal(inputs.plan.collectionReport.rows.length,2);assert.equal(inputs.plan.collectionReport.unavailableSources.length,2);
  assert(inputs.plan.collectionReport.rows.every(r=>r.reasons.includes('COLLECTION_DEADLINE')));assert.equal(inputs.plan.collectionReport.collection.terminal,true);
 }finally{await f.dispose();}
});
test('synthetic collection and a review before closure cannot create a production import plan',async()=>{
 const f=await retestImportFixture();try{
  const state=await f.close(),manifest=await retestSourceManifest(f.ctx,state);f.ctx.config.syntheticOnly=true;
  assert.throws(()=>buildRetestImport(planRef,f.ctx,state,f.sources,manifest,f.at),/synthetic_collection/);
  f.ctx.config.syntheticOnly=false;assert.throws(()=>buildRetestImport(planRef,f.ctx,state,f.sources,manifest,'2026-11-06T11:59:59.999Z'),/collection_not_closed/);
 }finally{await f.dispose();}
});
test('in-memory plan/source tampering is refused before a DB method or output is used',async()=>{
 const f=await retestImportFixture();try{
  await f.close();let inputs=await f.prepare();inputs.plan.accounts.push('999');await assert.rejects(executeRetestImportStep(inputs,{},'maps',join(f.root,'bad'),planRef),/plan_binding/);
  inputs=await f.prepare();inputs.maps[0].observation.source.fetchedAt='2026-11-06T12:01:00.000Z';
  await assert.rejects(executeRetestImportStep(inputs,{},'maps',join(f.root,'bad'),planRef),/map_binding/);assert(!(await readdir(f.root)).includes('bad'));
 }finally{await f.dispose();}
});
test('a conflicting discovery map already present in the base dataset cannot re-enter training history',()=>{
 assert.throws(()=>reconcileRetestImport({schemaVersion:2,format:'v1-retest-import-plan-v2',syntheticOnly:false,historyConflictMapIds:['1']},{source:{candidates:[{matchId:'1'}]}}),/history_discovery_conflict/);
});
test('query/detail outcome conflict remains explicit and cannot be imported as trusted history',async()=>{
 const f=await retestImportFixture();try{
  const raw={...f.rawMaps[0],match_id:'99999999',series_id:'699',start_time:Date.parse('2026-01-10T00:00:00.000Z')/1000,radiant_win:false};
  const row={account_id:'100',match_id:raw.match_id,leagueid:'100',start_time:raw.start_time,duration:raw.duration,radiant_win:true,player_slot:0,tier:'professional'};
  const provider=async(limit,hooks)=>{const p=await f.provider(limit,hooks),fetch=async(endpoint,data)=>{hooks.guard();await hooks.beforeRequest();await hooks.observe(200,null);return f.obs(endpoint,data);};
   return {...p,client:{getMatchSource:id=>id===raw.match_id?fetch('/matches/'+id,raw):p.client.getMatchSource(id)},
    discover:(...args)=>fetch('/explorer?'+new URLSearchParams({sql:playerHistoryQuery(...args)}),{err:null,rows:args[0].includes('100')?[row]:[]})};};
  await captureRetestBatch(f.ctx,'targets',provider);await captureRetestBatch(f.ctx,'history',provider);const inputs=await f.prepare();
  assert.deepEqual(inputs.plan.historyConflictMapIds,[raw.match_id]);assert(inputs.plan.maps.find(m=>m.matchId===raw.match_id).reasons.includes('HISTORY_DISCOVERY_CONFLICT'));
  assert(!inputs.plan.providerSeriesIds.includes('699'));await assert.rejects(retestImportProvider(inputs).getMatchSource(raw.match_id),/outside_plan/);
  assert.equal(inputs.plan.collectionReport.rows.length,2);assert.equal(inputs.plan.collectionReport.summary.invalidHistoryMaps,1);
 }finally{await f.dispose();}
});
test('old import plan format is refused without trying its config or opening a DB',async()=>{
 const f=await retestImportFixture();try{
  const path=join(f.root,'old.json'),bytes=JSON.stringify({schemaVersion:1,format:'v1-historical-import-plan-v1'});await writeFile(path,bytes);
  await assert.rejects(readRetestImportPlan(path,sha(bytes)),/plan_format/);
 }finally{await f.dispose();}
});
