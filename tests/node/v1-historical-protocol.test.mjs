import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {registerHistoricalProtocol,verifyHistoricalProtocol,inspectHistoricalDiscovery,readHistoricalInputs,readHistoricalCaptures,save,sha} from '../../scripts/lib/v1-historical-protocol.mjs';
import {V1_RELEASE_QUALITY_POLICY} from '../../packages/prediction/dist/v1-quality-policy.js';
import {canonicalContextJson} from '../../packages/db/dist/temporal.js';
import {verifyV1ReleasePlan} from '../../packages/db/dist/v1-release-plan.js';
const text=x=>JSON.stringify(x,null,2)+'\n',policyHash=sha(canonicalContextJson(V1_RELEASE_QUALITY_POLICY));
function fixture(){
 const at='2099-11-06T12:00:00.000Z';
 const rawBody=JSON.stringify([{leagueid:100,name:'Synthetic Main',tier:'professional'}]);
 const catalogue={source:{provider:'opendota',endpoint:'/leagues',fetchedAt:'2099-11-06T11:00:00.000Z',knownAt:null,payloadSha256:sha(rawBody)},rawBody};
 const exposure={schemaVersion:1,format:'v1-prior-exposure-v1',capturedAt:'2099-11-06T10:00:00.000Z',fileManifestSha256:'a'.repeat(64),databaseSnapshotSha256:'b'.repeat(64),declaredFileCount:2,
  blockedMatchIds:['100000001'],opendotaSeriesIds:['20'],limitations:['Synthetic bounded local audit only'],syntheticOnly:true};
 const request={schemaVersion:1,protocolKey:'synthetic-historical-test',evaluationBasis:'conditional_retrospective_unexposed_series',warmupFromAt:'2098-01-01T00:00:00.000Z',
  eventCutoffAt:'2099-11-01T00:00:00.000Z',maxInventoryMaps:5000,baseQualityPolicySha256:policyHash,catalogueSha256:sha(text(catalogue)),exposureSha256:sha(text(exposure)),
  exposureAcknowledgement:'bounded_local_audit_not_global_blindness_proof',earlierProtocolsUse:'archive_or_separate_monitoring_no_best_result_selection',
  events:[{eventKey:'synthetic-main',name:'Synthetic Main',provider:'opendota',leagueId:'100',catalogueName:'Synthetic Main',stage:'main_event',fromAt:'2099-09-01T00:00:00.000Z',until:'2099-10-01T00:00:00.000Z',
    tierDecision:{basis:'reviewed_event_scope',sourceUrl:'https://example.invalid/event',reviewedAt:'2099-11-06T09:00:00.000Z',rationale:'Synthetic explicit scope review before model scoring'},scheduleSourceUrl:'https://example.invalid/event'}]};
 const plan=()=>registerHistoricalProtocol(request,catalogue,exposure,at);
 const row=(id,series='10',extras={})=>({match_id:id,series_id:series,leagueid:100,start_time:Date.parse('2099-09-10T00:00:00Z')/1000,radiant_team_id:1,dire_team_id:2,...extras});
 const capture=rows=>{const rawBody=JSON.stringify(rows);return {source:{provider:'opendota',endpoint:'/leagues/100/matches',fetchedAt:'2099-11-06T12:01:00.000Z',knownAt:null,payloadSha256:sha(rawBody)},rawBody};};
 const inspect=rows=>inspectHistoricalDiscovery(plan(),catalogue,exposure,[capture(rows)],'2099-11-06T12:02:00.000Z');
 return {at,request,catalogue,exposure,plan,row,capture,inspect};
}
test('historical protocol registers after the event with explicit retrospective clocks and unchanged numeric gates',()=>{
 const f=fixture(),p=f.plan();assert(p.registeredAt>p.request.events[0].until);assert.equal(p.status,'historical_protocol_registered_not_evaluated');
 for(const key of ['model','history','scoring','calibration','uncertainty','stability'])assert.deepEqual(p.qualityPolicy[key],V1_RELEASE_QUALITY_POLICY[key]);
 assert.equal(p.qualityPolicy.sample.minMaps,100);assert.equal(p.qualityPolicy.sample.minSeries,40);assert.equal(p.qualityPolicy.sample.minMapCoverage,0.8);
 assert.equal(p.registryCompatible,false);assert.equal(p.deployable,false);assert.equal(p.teamAWinProbability,null);
 assert.equal(p.independence.basis,'before_model_scoring_not_before_historical_event');
 assert.deepEqual(verifyHistoricalProtocol(p,f.catalogue,f.exposure),p);
 assert.throws(()=>verifyV1ReleasePlan(p,f.catalogue,{}));
});
test('future event/cutoff/evidence, stale catalogue and invalid clock cannot register',()=>{
 for(const mutate of [f=>f.request.eventCutoffAt='2100-01-01T00:00:00.000Z',f=>f.exposure.capturedAt='2100-01-01T00:00:00.000Z',
  f=>f.request.events[0].tierDecision.reviewedAt='2100-01-01T00:00:00.000Z',f=>f.catalogue.source.fetchedAt='2100-01-01T00:00:00.000Z']){
  const f=fixture();mutate(f);assert.throws(f.plan,/historical_future_evidence/);
 }
 const f=fixture();f.catalogue.source.fetchedAt='2099-11-05T11:59:59.999Z';assert.throws(f.plan,/historical_catalogue_stale/);
 assert.throws(()=>registerHistoricalProtocol(f.request,f.catalogue,f.exposure,'not-time'),/clock_invalid/);
});
test('wrong ID, ambiguous catalogue, qualifier scope and changed model policy fail closed',()=>{
 let f=fixture();f.request.events[0].leagueId='999';assert.throws(f.plan,/event_binding/);
 f=fixture();f.catalogue.rawBody=JSON.stringify([{leagueid:100,name:'Synthetic Main',tier:'professional'},{leagueid:100,name:'Synthetic Main',tier:'professional'}]);f.catalogue.source.payloadSha256=sha(f.catalogue.rawBody);assert.throws(f.plan,/event_binding/);
 f=fixture();f.request.events[0].name='Synthetic Main Qualifiers';assert.throws(f.plan,/request_invalid/);
 f=fixture();f.request.baseQualityPolicySha256='e'.repeat(64);assert.throws(f.plan,/base_policy_changed/);
 f=fixture();f.request.unregisteredSelection='best results';assert.throws(f.plan,/request_invalid/);
});
test('altered exposure IDs with the same counts or changed protocol cannot pass replay',()=>{
 const f=fixture(),p=f.plan();f.exposure.blockedMatchIds=['100000999'];assert.throws(()=>verifyHistoricalProtocol(p,f.catalogue,f.exposure),/protocol_replay/);
 const g=fixture(),q=g.plan();q.qualityPolicy.sample.minMaps=1;assert.throws(()=>verifyHistoricalProtocol(q,g.catalogue,g.exposure),/protocol_replay/);
 const h=fixture();assert.throws(()=>verifyHistoricalProtocol(h.plan(),h.catalogue,h.exposure,{...h.request,protocolKey:'substituted-request'}),/request_binding/);
});
test('any exposed map excludes every known sibling, separately from quality coverage failures',()=>{
 const f=fixture(),r=f.inspect([f.row('100000001'),f.row('100000002'),f.row('100000003','11')]);
 assert.deepEqual(r.ledger.map(m=>m.exposureExcluded),[true,true,false]);assert.equal(r.summary.metadataCandidateMaps,1);assert.equal(r.summary.priorExposedSeries,1);
 assert.equal(r.coverageGateCalculated,false);assert.equal(r.eligibilityVerified,false);
});
test('known provider series excludes unseen map IDs and unknown series stay unresolved',()=>{
 const f=fixture(),r=f.inspect([f.row('100000010','20'),f.row('100000011',null)]);
 assert.equal(r.ledger[0].exposureExcluded,true);assert.equal(r.ledger[1].exposureExcluded,false);assert(r.ledger[1].reasons.includes('SERIES_ID_PENDING'));
 assert.equal(r.summary.unexposedTargetMaps,1);assert.equal(r.summary.unresolvedMaps,1);
});
test('strict right boundary and out-of-window sibling exclude the whole series',()=>{
 const f=fixture(),r=f.inspect([f.row('100000010','10'),f.row('100000011','10',{start_time:Date.parse(f.request.events[0].until)/1000})]);
 assert.equal(r.summary.metadataCandidateMaps,0);assert.equal(r.summary.targetWindowMaps,1);
 assert(r.ledger.every(m=>m.reasons.includes('SERIES_OUTSIDE_WINDOW')));
 const left=f.inspect([f.row('100000010','10',{start_time:Date.parse(f.request.events[0].fromAt)/1000})]);assert.equal(left.summary.metadataCandidateMaps,1);
});
test('side swaps keep unordered pair identity while missing teams/context conflict remain pending',()=>{
 const f=fixture();let r=f.inspect([f.row('100000010'),f.row('100000011','10',{radiant_team_id:2,dire_team_id:1})]);assert.equal(r.summary.metadataCandidateMaps,2);
 r=f.inspect([f.row('100000010'),f.row('100000011','10',{dire_team_id:3})]);assert(r.ledger.every(m=>m.reasons.includes('SERIES_CONTEXT_CONFLICT')));
 r=f.inspect([f.row('100000010','10',{radiant_team_id:null})]);assert.equal(r.summary.metadataCandidateMaps,0);assert(r.ledger[0].reasons.includes('TEAM_CONTEXT_PENDING'));
});
test('metadata selection is invariant to winner/score/performance changes and never outputs them',()=>{
 const f=fixture(),a=f.inspect([f.row('100000010','10',{radiant_win:true,radiant_score:45,duration:3000})]),b=f.inspect([f.row('100000010','10',{radiant_win:false,radiant_score:1,duration:1000})]);
 assert.deepEqual(a.ledger,b.ledger);assert.deepEqual(a.summary,b.summary);
 assert(!JSON.stringify(a.ledger).includes('radiant_win'));assert.equal(a.metrics,null);assert.equal(a.teamAWinProbability,null);
});
test('discovery source hash, endpoint, clocks, league and conflicting duplicate IDs are enforced',()=>{
 const f=fixture(),p=f.plan();
 for(const mutate of [c=>c.rawBody+=' ',c=>c.source.endpoint='/leagues/999/matches',c=>c.source.fetchedAt='2099-11-06T11:59:59.999Z',c=>c.source.fetchedAt='2100-01-01T00:00:00.000Z']){
  const c=f.capture([f.row('100000010')]);mutate(c);assert.throws(()=>inspectHistoricalDiscovery(p,f.catalogue,f.exposure,[c],'2099-11-06T12:02:00.000Z'),/historical_discovery_/);
 }
 assert.throws(()=>f.inspect([f.row('100000010','10',{leagueid:999})]),/league_conflict/);
 assert.throws(()=>f.inspect([f.row('100000010'),f.row('100000010','11')]),/map_conflict/);
 const r=f.inspect([f.row('100000010'),f.row('100000010')]);assert.equal(r.duplicates,1);assert.equal(r.summary.metadataCandidateMaps,1);
});
test('empty/missing source and inventory overflow cannot appear as an eligible evaluation',()=>{
 const f=fixture(),r=inspectHistoricalDiscovery(f.plan(),f.catalogue,f.exposure,[],'2099-11-06T12:02:00.000Z');
 assert.equal(r.missingEvents.length,1);assert.equal(r.summary.metadataCandidateMaps,0);assert.equal(r.metrics,null);
 const rows=Array.from({length:5001},(_,i)=>f.row(String(100010000+i),String(100+i)));
 assert.throws(()=>f.inspect(rows),/inventory_overflow/);
});
test('file reader enforces exact byte hashes/bindings, and output is exclusive',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'v1-historical-'));
 try{
  const f=fixture(),ref=async(name,value)=>{const path=join(dir,name),content=text(value);await writeFile(path,content);return {path,sha256:sha(content)};};
  const config={schemaVersion:1,request:await ref('request.json',f.request),catalogue:await ref('catalogue.json',f.catalogue),exposure:await ref('exposure.json',f.exposure)};
  const input=await ref('input.json',config);assert.deepEqual((await readHistoricalInputs(input.path,input.sha256)).request,f.request);
  await assert.rejects(readHistoricalInputs(input.path,'0'.repeat(64)),/sha_mismatch/);
  await writeFile(config.exposure.path,text({...f.exposure,blockedMatchIds:[]}));await assert.rejects(readHistoricalInputs(input.path,input.sha256),/sha_mismatch/);
  const cap=await ref('capture.json',f.capture([])),caps=await ref('captures.json',{schemaVersion:1,captures:[cap]});assert.equal((await readHistoricalCaptures(caps.path,caps.sha256)).length,1);
  const out=join(dir,'plan.json');await save(out,f.plan());await assert.rejects(save(out,{}),e=>e.code==='EEXIST');assert.equal(JSON.parse(await readFile(out,'utf8')).format,'v1-historical-protocol-v1');
 }finally{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert(basename(dir).startsWith('v1-historical-'));await rm(dir,{recursive:true,force:true});}
});
