import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {registerRetestProtocol,verifyRetestProtocol,retestMetadata,readRetestInputs,save,sha} from '../../scripts/lib/v1-retest-protocol.mjs';
import {registerHistoricalProtocol,verifyHistoricalProtocol} from '../../scripts/lib/v1-historical-protocol.mjs';
import {V1HistoricalRequestSchema} from '../../packages/contracts/dist/v1-historical-protocol.js';
import {V1_RELEASE_QUALITY_POLICY} from '../../packages/prediction/dist/v1-quality-policy.js';
import {canonicalContextJson} from '../../packages/db/dist/temporal.js';
const text=v=>JSON.stringify(v,null,2)+'\n',hash=v=>sha(canonicalContextJson(v)),stamp=v=>({...v,fingerprint:hash(v)});
const ref=(path,data)=>({path,sha256:sha(text(data))});
const at='2099-11-06T12:05:00.000Z';
function fixture(){
  const rawBody=JSON.stringify([{leagueid:77,name:'Synthetic Prior Main',tier:'professional'},
    ...Array.from({length:7},(_,i)=>({leagueid:100+i,name:`Synthetic Main ${i}`,tier:'professional'}))]);
  const catalogue={source:{provider:'opendota',endpoint:'/leagues',fetchedAt:'2099-11-06T09:00:00.000Z',knownAt:null,payloadSha256:sha(rawBody)},rawBody};
  const exposure={schemaVersion:1,format:'v1-prior-exposure-v1',capturedAt:'2099-11-06T09:30:00.000Z',fileManifestSha256:'a'.repeat(64),databaseSnapshotSha256:'b'.repeat(64),declaredFileCount:0,blockedMatchIds:[],opendotaSeriesIds:[],limitations:['Synthetic fixture'],syntheticOnly:true};
  const event={eventKey:'synthetic-prior',name:'Synthetic Prior Main',provider:'opendota',leagueId:'77',catalogueName:'Synthetic Prior Main',stage:'main_event',fromAt:'2099-09-01T00:00:00.000Z',until:'2099-10-01T00:00:00.000Z',tierDecision:{basis:'reviewed_event_scope',sourceUrl:'https://example.invalid/prior',reviewedAt:'2099-11-06T09:00:00.000Z',rationale:'Synthetic prior protocol, never deployable'},scheduleSourceUrl:'https://example.invalid/prior'};
  const oldRequest={schemaVersion:1,protocolKey:'synthetic-prior-protocol',evaluationBasis:'conditional_retrospective_unexposed_series',warmupFromAt:'2098-01-01T00:00:00.000Z',eventCutoffAt:'2099-11-01T00:00:00.000Z',maxInventoryMaps:5000,baseQualityPolicySha256:hash(V1_RELEASE_QUALITY_POLICY),catalogueSha256:sha(text(catalogue)),exposureSha256:sha(text(exposure)),exposureAcknowledgement:'bounded_local_audit_not_global_blindness_proof',earlierProtocolsUse:'archive_or_separate_monitoring_no_best_result_selection',events:[event]};
  const protocol=registerHistoricalProtocol(oldRequest,catalogue,exposure,'2099-11-06T10:00:00.000Z');
  const freeze=stamp({format:'v1-historical-executable-freeze-v1',registeredAt:'2099-11-06T10:01:00.000Z',protocolSha256:sha(text(protocol)),protocolFingerprint:protocol.fingerprint,qualityPolicySha256:protocol.qualityPolicySha256,capsuleSha256:'c'.repeat(64),datasetFingerprint:'d'.repeat(64),candidateFingerprint:'e'.repeat(64)});
  const started={format:'v1-historical-first-scoring-v1',startedAt:'2099-11-06T11:00:00.000Z',freezeSha256:sha(text(freeze)),freezeFingerprint:freeze.fingerprint,capsuleSha256:freeze.capsuleSha256};
  const common={freezeSha256:sha(text(freeze)),freezeFingerprint:freeze.fingerprint,protocolFingerprint:protocol.fingerprint,datasetFingerprint:freeze.datasetFingerprint,candidateFingerprint:freeze.candidateFingerprint,qualityPolicySha256:protocol.qualityPolicySha256};
  const report=stamp({format:'v1-historical-evaluation-v1',...common,capsuleSha256:freeze.capsuleSha256,firstScoring:started,qualityDecision:'failed',releaseGatePassed:false});
  const registry=stamp({format:'v1-historical-registry-binding-v1',...common,evaluationFingerprint:report.fingerprint,qualityDecision:'failed',eligibleForActivation:false,isActive:false,deployable:false});
  const events=Array.from({length:7},(_,i)=>({leagueId:String(100+i),name:`Synthetic Main ${i}`,fromAt:'2099-02-01T00:00:00.000Z',until:'2099-03-01T00:00:00.000Z',sourceUrl:'https://example.invalid/main'}));
  const intent={format:'v1-retest-proposal-intent-v1',createdAt:'2099-11-06T12:00:00.000Z',status:'proposal_not_registered_release_protocol',priorReport:{...ref('old-report.json',report),decision:'failed'},events,warmupFromAt:'2098-01-01T00:00:00.000Z',eventCutoffAt:'2099-07-01T00:00:00.000Z',wholeEventExclusions:[{leagueId:'77',reason:'previous failed cohort'}],limits:{maxDiscoveryHttpRequests:14,maxUniqueMaps:5000,maxDetailAttemptsPerMap:3,proposedCollectionDeadline:'2099-11-13T00:00:00.000Z'},unchangedModel:{initialRating:1500,k:32,scale:400,minPriorMapsPerPlayer:5,calibrator:false},qualityPolicySha256:protocol.qualityPolicySha256,disclosures:['Synthetic only, no global blindness claim'],freshEvaluationPerformed:false,automaticActivation:false};
  const fileExposure={capturedAt:'2099-11-06T12:01:00.000Z',files:[],potentialMapIds:['100000001'],opendotaSeriesIds:['31']};
  const databaseExposure={capturedAt:'2099-11-06T12:01:01.000Z',maps:[{matchId:'100000009',leagueId:null,provider:'pandascore',providerSeriesId:'33'}]};
  const row=(id,series,leagueId='100',extra={})=>({match_id:id,series_id:series,leagueid:leagueId,start_time:Date.parse('2099-02-10T00:00:00Z')/1000,radiant_team_id:'1',dire_team_id:'2',...extra});
  const make=(leagueId,rows)=>{const rawBody=JSON.stringify(rows);return {source:{provider:'opendota',endpoint:`/leagues/${leagueId}/matches`,fetchedAt:'2099-11-06T12:02:00.000Z',knownAt:null,payloadSha256:sha(rawBody)},rawBody};};
  const captures=events.map((e,i)=>make(e.leagueId,i?[]:[row('100000001','30'),row('100000002','30'),row('100000003','31'),row('100000004','32'),row('100000005','32','100',{radiant_team_id:'2',dire_team_id:'1'}),row('100000006',null),row('100000007','33')]));
  const normalized={capturedAt:databaseExposure.capturedAt,blockedMatchIds:['100000001','100000009'],opendotaSeriesIds:['31']};
  const review=retestMetadata(intent,normalized,captures,'2099-11-06T12:03:00.000Z');
  const metadataReview={intentSha256:sha(text(intent)),summary:review.summary,ledger:review.ledger,detailEligibilityVerified:false,newModelEvaluationPerformed:false};
  const collection={historyWarmupFromAt:intent.warmupFromAt,historyRequestBeforeAt:events[0].fromAt,historyWindowDays:730,historyMaxMapsPerAccount:10,maxMaps:5000,maxDetailAttemptsPerMap:3,maxRequestsPerRun:50,collectionDeadline:intent.limits.proposedCollectionDeadline,stop:'all_work_terminal_or_deadline',evaluation:'one_after_terminal_collection_and_verified_freeze',missingTargets:'retain_in_coverage_denominator',historySelection:'latest_completed_before_global_cutoff_numeric_account_groups_of_five',perMapFeatureCutoff:'completed_at_strictly_before_target_start',extendAfterScoring:false,automaticActivation:false};
  const captureIndex={captures:captures.map((c,i)=>ref(`capture-${i}.json`,c)),completedAt:'2099-11-06T12:02:30.000Z'};
  const proposal={format:'v1-retest-proposal-checkpoint-v1',checkedAt:'2099-11-06T12:03:00.000Z',status:'metadata_feasible_registration_pending',protocolRegistered:false,freshModelEvaluationPerformed:false,deployable:false,teamAWinProbability:null,intent:ref('intent.json',intent),catalogue:ref('catalogue.json',catalogue),pilotReport:ref('old-report.json',report),pilotDecision:'failed',qualityPolicySha256:protocol.qualityPolicySha256,exposure:{fileManifest:ref('file-exposure.json',fileExposure),databaseSnapshot:ref('db-exposure.json',databaseExposure),capturedAt:fileExposure.capturedAt,fileCount:0},sourceCapture:ref('captures.json',captureIndex),metadataReview:ref('metadata.json',metadataReview),proposal:{eventCount:7,...collection},summary:review.summary,syntheticOnly:true};
  const accessEvidence={syntheticOnly:true,scope:'fixture'};
  const accessReview={schemaVersion:1,proposalSha256:sha(text(proposal)),checkedAt:'2099-11-06T12:04:00.000Z',basis:'bounded_local_file_and_database_review',newOutcomeOrModelAccess:false,additionalExposedMatchIds:[],additionalExposedSeriesIds:[],evidence:ref('access-evidence.json',accessEvidence),limitations:['Synthetic fixture only']};
  const request={schemaVersion:2,protocolKey:'synthetic-retest-seven',proposalSha256:sha(text(proposal)),collection,priorAttempt:'preserve_first_fail_no_best_result_selection',exposureAcknowledgement:'bounded_local_audit_not_global_blindness_proof'};
  const refs={schemaVersion:2,request:ref('request.json',request),proposal:ref('proposal.json',proposal),intent:proposal.intent,catalogue:proposal.catalogue,fileExposure:proposal.exposure.fileManifest,databaseExposure:proposal.exposure.databaseSnapshot,captureIndex:proposal.sourceCapture,metadataReview:proposal.metadataReview,accessReview:ref('access.json',accessReview),previous:{inputs:ref('old-inputs.json',{}),protocol:ref('old-protocol.json',protocol),freeze:ref('old-freeze.json',freeze),started:ref('old-started.json',started),report:proposal.pilotReport,registry:ref('old-registry.json',registry)}};
  const ctx={refs,request,proposal,intent,catalogue,fileExposure,databaseExposure,captureIndex,metadataReview,accessReview,captures,previous:{inputs:{request:oldRequest,catalogue,exposure},protocol,freeze,started,report,registry}};
  return {ctx,normalized,row,make,accessEvidence,plan:()=>registerRetestProtocol(ctx,at)};
}
test('seven-event v2 preserves the failed attempt, unknown denominator and unchanged quality policy',()=>{
  const f=fixture(),p=f.plan();assert.equal(p.schemaVersion,2);assert.equal(p.request.events.length,7);
  assert.deepEqual(p.metadata.denominator,{maps:4,knownSeries:2,unknownSeriesMaps:1});
  assert.equal(p.metadata.summary.metadataCandidates.maps,3);assert.equal(p.metadata.summary.priorExposed.maps,3);
  assert.equal(p.previousAttempt.reportSha256,f.ctx.refs.previous.report.sha256);assert.equal(p.previousAttempt.qualityDecision,'failed');
  assert.deepEqual(p.qualityPolicy,f.ctx.previous.protocol.qualityPolicy);assert.equal(p.syntheticOnly,true);assert.equal(p.deployable,false);assert.equal(p.evaluation,null);
  assert.deepEqual(verifyRetestProtocol(p,f.ctx),p);
});
test('v1 remains byte-identical and refuses a seven-event request or a v2 protocol',()=>{
  const f=fixture(),old=f.ctx.previous,bytes=text(old.protocol);
  verifyHistoricalProtocol(old.protocol,old.inputs.catalogue,old.inputs.exposure,old.inputs.request);assert.equal(text(old.protocol),bytes);
  assert.equal(V1HistoricalRequestSchema.safeParse({...old.inputs.request,events:Array(7).fill(old.inputs.request.events[0])}).success,false);
  assert.throws(()=>verifyHistoricalProtocol(f.plan(),old.inputs.catalogue,old.inputs.exposure),/protocol_format/);
});
test('replay rejects changes to scope, policy, deadline, denominator, prior result and extra fields',()=>{
  for(const mutate of [p=>p.request.events.pop(),p=>p.qualityPolicy.model.k=16,p=>p.collection.collectionDeadline='2099-11-14T00:00:00.000Z',p=>p.metadata.denominator.maps--,p=>p.previousAttempt.qualityDecision='passed',p=>p.approved=true]){
    const f=fixture(),p=structuredClone(f.plan());mutate(p);assert.throws(()=>verifyRetestProtocol(p,f.ctx),/protocol_replay/);
  }
});
test('registration rejects changed collection parameters, later deadline, hidden events and premature or late clocks',()=>{
  for(const mutate of [f=>f.ctx.request.collection.maxDetailAttemptsPerMap=4,f=>f.ctx.request.events=[],
    f=>f.ctx.request.collection.historyRequestBeforeAt='2099-02-02T00:00:00.000Z',
    f=>f.ctx.request.collection.collectionDeadline='2099-11-14T00:00:00.000Z',
    f=>f.ctx.accessReview.newOutcomeOrModelAccess=true,f=>f.ctx.accessReview.additionalExposedMatchIds.push('100000007')]){
    const f=fixture();f.ctx.request=structuredClone(f.ctx.request);mutate(f);assert.throws(f.plan,/retest_/);
  }
  const f=fixture();assert.throws(()=>registerRetestProtocol(f.ctx,'2099-11-06T12:03:00.000Z'),/evidence_clock/);
  assert.throws(()=>registerRetestProtocol(f.ctx,'2099-11-13T00:00:00.000Z'),/registration_deadline/);
  // Replay is forever relative to registration, not dependent on today's clock.
  assert.deepEqual(verifyRetestProtocol(f.plan(),f.ctx),f.plan());
});
test('first FAIL cannot be replaced, relabelled, omitted, or disconnected from its first receipt',()=>{
  for(const mutate of [f=>f.ctx.previous.report.qualityDecision='passed',f=>f.ctx.previous.registry.eligibleForActivation=true,
    f=>f.ctx.previous.started.startedAt='2099-11-06T11:01:00.000Z',f=>f.ctx.proposal.pilotReport.sha256='0'.repeat(64),
    f=>f.ctx.previous.freeze.protocolFingerprint='0'.repeat(64)]){
    const f=fixture();f.ctx=structuredClone(f.ctx);mutate(f);assert.throws(()=>registerRetestProtocol(f.ctx,at),/prior_/);
  }
});
test('metadata never selects on outcomes; whole-series exposure and provider namespaces are respected',()=>{
  const f=fixture(),a=retestMetadata(f.ctx.intent,f.normalized,f.ctx.captures,at);
  const caps=f.ctx.captures.map(c=>{const x=structuredClone(c),rows=JSON.parse(x.rawBody);for(const r of rows){r.radiant_win=false;r.duration=1;r.radiant_score=999;}x.rawBody=JSON.stringify(rows);x.source.payloadSha256=sha(x.rawBody);return x;});
  const b=retestMetadata(f.ctx.intent,f.normalized,caps,at);assert.deepEqual(a.ledger,b.ledger);
  assert(a.ledger.filter(r=>r.seriesId==='30').every(r=>r.priorExposure));
  assert.equal(a.ledger.find(r=>r.seriesId==='33').metadataCandidate,true);assert(!JSON.stringify(a.ledger).includes('radiant_win'));
});
test('missing events, conflicting duplicates, changed hashes, clocks and cross-event series fail safely',()=>{
  const f=fixture(),run=c=>retestMetadata(f.ctx.intent,f.normalized,c,at);
  assert.throws(()=>run(f.ctx.captures.slice(1)),/missing_event/);assert.throws(()=>run([...f.ctx.captures,f.ctx.captures[0]]),/discovery_event/);
  let c=structuredClone(f.ctx.captures);c[0].rawBody+=' ';assert.throws(()=>run(c),/discovery_hash/);
  c=structuredClone(f.ctx.captures);c[0].source.fetchedAt=f.normalized.capturedAt;assert.throws(()=>run(c),/discovery_clock/);
  c=structuredClone(f.ctx.captures);c[0]=f.make('100',[f.row('100000010','40'),f.row('100000010','41')]);assert.throws(()=>run(c),/conflict/);
  c=structuredClone(f.ctx.captures);c[0]=f.make('100',[f.row('100000010','40')]);c[1]=f.make('101',[f.row('100000011','40','101')]);
  assert(run(c).ledger.every(r=>r.reasons.includes('SERIES_CONTEXT_CONFLICT')));
});
test('timestamp bounds, missing teams, zero rows and unknown series remain explicit',()=>{
  const f=fixture(),c=structuredClone(f.ctx.captures);
  c[0]=f.make('100',[f.row('100000010','40','100',{start_time:Date.parse(f.ctx.intent.events[0].fromAt)/1000}),
    f.row('100000011','40','100',{start_time:Date.parse(f.ctx.intent.events[0].until)/1000}),f.row('100000012','41','100',{radiant_team_id:null}),f.row('100000013',null,'100',{start_time:null})]);
  const r=retestMetadata(f.ctx.intent,f.normalized,c,at);assert.equal(r.summary.metadataCandidates.maps,0);assert.equal(r.denominator.maps,3);
  assert(r.ledger.filter(r=>r.seriesId==='40').every(r=>r.reasons.includes('SERIES_OUTSIDE_WINDOW')));
  const empty=retestMetadata(f.ctx.intent,f.normalized,f.ctx.intent.events.map(e=>f.make(e.leagueId,[])),at);assert.equal(empty.summary.observed.maps,0);assert.equal(empty.eligibilityVerified,false);
});
test('catalogue/ledger/source bindings and inventory limits are checked before registration',()=>{
  for(const mutate of [f=>f.ctx.metadataReview.ledger.pop(),f=>f.ctx.proposal.summary.observed.maps++,
    f=>f.ctx.refs.intent.sha256='0'.repeat(64),f=>f.ctx.intent.events[0].name='Different Main',
    f=>f.ctx.intent.events[0].name='Synthetic Qualifiers',f=>f.ctx.proposal.qualityPolicySha256='0'.repeat(64)]){
    const f=fixture();f.ctx=structuredClone(f.ctx);mutate(f);assert.throws(()=>registerRetestProtocol(f.ctx,at),/retest_/);
  }
  const f=fixture(),c=structuredClone(f.ctx.captures);c[0]=f.make('100',Array.from({length:5001},(_,i)=>f.row(String(100010000+i),String(100+i))));
  assert.throws(()=>retestMetadata(f.ctx.intent,f.normalized,c,at),/inventory_overflow/);
});
test('file/CLI boundary pins every nested source and refuses overwriting an existing plan',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'v1-retest-'));
  try{
    const f=fixture(),ctx=f.ctx,put=async(name,data)=>{const path=join(dir,name);await writeFile(path,text(data));return ref(path,data);};
    for(const [i,c] of ctx.captures.entries())ctx.captureIndex.captures[i]=await put(`capture-${i}.json`,c);
    ctx.proposal.sourceCapture=await put('captures.json',ctx.captureIndex);
    for(const [key,value] of Object.entries({intent:ctx.intent,catalogue:ctx.catalogue,metadataReview:ctx.metadataReview}))ctx.proposal[key]=await put(`${key}.json`,value);
    ctx.proposal.exposure.fileManifest=await put('file-exposure.json',ctx.fileExposure);ctx.proposal.exposure.databaseSnapshot=await put('db-exposure.json',ctx.databaseExposure);
    ctx.accessReview.evidence=await put('access-evidence.json',f.accessEvidence);
    ctx.proposal.pilotReport=await put('old-report.json',ctx.previous.report);
    const prior=ctx.previous,oldInputs={schemaVersion:1,request:await put('old-request.json',prior.inputs.request),catalogue:ctx.proposal.catalogue,exposure:await put('old-exposure.json',prior.inputs.exposure)};
    const previous={inputs:await put('old-inputs.json',oldInputs)};for(const key of ['protocol','freeze','started','report','registry'])previous[key]=await put(`old-${key}.json`,prior[key]);
    const proposal=await put('proposal.json',ctx.proposal);ctx.request.proposalSha256=proposal.sha256;ctx.accessReview.proposalSha256=proposal.sha256;
    const config={schemaVersion:2,request:await put('request.json',ctx.request),proposal,intent:ctx.proposal.intent,catalogue:ctx.proposal.catalogue,fileExposure:ctx.proposal.exposure.fileManifest,databaseExposure:ctx.proposal.exposure.databaseSnapshot,captureIndex:ctx.proposal.sourceCapture,metadataReview:ctx.proposal.metadataReview,accessReview:await put('access.json',ctx.accessReview),previous};
    const configRef=await put('config.json',config),loaded=await readRetestInputs(configRef.path,configRef.sha256),plan=registerRetestProtocol(loaded,at),out=join(dir,'plan.json');
    await save(out,plan);const before=await readFile(out);await assert.rejects(save(out,{}),e=>e.code==='EEXIST');assert.deepEqual(await readFile(out),before);
    const cli=spawnSync(process.execPath,['scripts/plan-v1-retest.mjs','verify',configRef.path,configRef.sha256,out,sha(before)],{encoding:'utf8'});
    assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).status,'retest_protocol_verified');
    await writeFile(previous.report.path,text({...prior.report,releaseGatePassed:true}));await assert.rejects(readRetestInputs(configRef.path,configRef.sha256),/sha_mismatch/);
    assert.deepEqual(await readFile(out),before);
  }finally{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert(basename(dir).startsWith('v1-retest-'));await rm(dir,{recursive:true,force:true});}
});
