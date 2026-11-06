import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {prepareV1Data} from '../../packages/db/dist/v1-data.js';
import {V1_RELEASE_QUALITY_POLICY} from '../../packages/prediction/dist/v1-quality-policy.js';
import {registerHistoricalProtocol,sha} from '../../scripts/lib/v1-historical-protocol.mjs';
import {reconcileHistoricalImport} from '../../scripts/lib/v1-historical-import.mjs';
import {historicalHash,verifyHistoricalCapsule,registerHistoricalFreeze,verifyHistoricalFreeze,
  scoreHistoricalEvaluation,historicalRegistryBinding,historicalCandidate} from '../../scripts/lib/v1-historical-execution.mjs';
import {saveHistoricalBundle,loadHistoricalBundle,evaluateHistoricalBundle} from '../../scripts/lib/v1-historical-bundle.mjs';
import {releaseExecutionCode,releaseRuntime} from '../../scripts/lib/v1-release-files.mjs';

const at='2026-11-06T10:00:00.000Z',observed='2026-11-06T09:00:00.000Z',registered='2026-11-06T11:00:00.000Z';
const text=v=>JSON.stringify(v,null,2)+'\n',evidence=v=>({text:text(v),sha256:sha(text(v))});
const stamp=v=>({...v,fingerprint:historicalHash(v)}),us=t=>String(BigInt(Date.parse(t))*1000n);
const code=['scripts/historical-v1.mjs','scripts/lib/v1-historical-execution.mjs','scripts/lib/v1-historical-bundle.mjs',
  'packages/prediction/dist/v1-features.js','packages/prediction/dist/v1-candidate.js','packages/prediction/dist/v1-quality.js'].map(path=>({path,sha256:'b'.repeat(64)}));
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinarySha256:'c'.repeat(64)};
function fixture(mutate=()=>{}){
  const players=Array.from({length:10},(_,i)=>({playerSlot:i<5?i:i+123,sourceAccountId:String(i+100)}));
  const candidates=Array.from({length:8},(_,i)=>{
    const id=String(i+1),start=new Date(Date.UTC(2026,7,i+1)).toISOString(),end=new Date(Date.parse(start)+1800000).toISOString();
    const seriesId=`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
    return {matchId:id,startedAtUs:us(start),endedAtUs:us(end),syncedAtUs:us(observed),dataRevision:'1',isPro:true,ingestState:'accepted',radiantWin:i%3!==2,
      radiantTeamId:'22',direTeamId:'11',seriesId,players:structuredClone(players),receiptPlayers:structuredClone(players),seriesSourceMatched:true,facts:[],
      outcome:{status:'verified',matchId:id,outcomeReceiptId:id,teamAId:'22',teamBId:'11',teamAWon:i%3!==2,startedAt:start,completedAt:end,seriesId,dataRevision:'1',labelVerifiedAt:at,
        sourceEvidence:{receiptId:id,payloadSha256:'a'.repeat(64),adapterVersion:'synthetic',normalizerVersion:'synthetic',receiptFetchedAt:observed}}};
  });
  const request={schemaVersion:1,profile:'pre-match-player-elo-data-v1',purpose:'development_only',fromAt:'2024-01-01T00:00:00.000Z',toAt:'2026-11-01T00:00:00.000Z',snapshotAt:at,maxMaps:5000};
  const source={request,identityRevision:'1',candidates,aliases:candidates.map((m,i)=>({seriesId:m.seriesId,provider:'opendota',providerSeriesId:String(i+1),teamAId:'22',teamBId:'11'})),
    identities:players.map((p,i)=>({observationId:'proof:'+i,playerId:String(i+1),provider:'opendota',externalAccountId:p.sourceAccountId,status:'verified',eventAt:null,knownAt:observed,fetchedAt:observed,evidenceRef:'synthetic-account',source:'synthetic'})),
    code:[{path:'synthetic-test.js',sha256:'b'.repeat(64)}],syntheticOnly:true};
  const rawBody=JSON.stringify([{leagueid:100,name:'Synthetic Main',tier:'professional'}]);
  const catalogue={source:{provider:'opendota',endpoint:'/leagues',fetchedAt:observed,knownAt:null,payloadSha256:sha(rawBody)},rawBody};
  const exposure={schemaVersion:1,format:'v1-prior-exposure-v1',capturedAt:observed,fileManifestSha256:'a'.repeat(64),databaseSnapshotSha256:'b'.repeat(64),
    declaredFileCount:1,blockedMatchIds:['7'],opendotaSeriesIds:['7'],limitations:['Synthetic local test only'],syntheticOnly:true};
  const req={schemaVersion:1,protocolKey:'synthetic-historical-freeze',evaluationBasis:'conditional_retrospective_unexposed_series',warmupFromAt:request.fromAt,eventCutoffAt:request.toAt,maxInventoryMaps:5000,
    baseQualityPolicySha256:historicalHash(V1_RELEASE_QUALITY_POLICY),catalogueSha256:evidence(catalogue).sha256,exposureSha256:evidence(exposure).sha256,
    exposureAcknowledgement:'bounded_local_audit_not_global_blindness_proof',earlierProtocolsUse:'archive_or_separate_monitoring_no_best_result_selection',
    events:[{eventKey:'synthetic-main',name:'Synthetic Main',provider:'opendota',leagueId:'100',catalogueName:'Synthetic Main',stage:'main_event',fromAt:'2026-08-01T00:00:00.000Z',until:'2026-09-01T00:00:00.000Z',
      tierDecision:{basis:'reviewed_event_scope',sourceUrl:'https://example.invalid/event',reviewedAt:observed,rationale:'Synthetic reviewed main event'},scheduleSourceUrl:'https://example.invalid/event'}]};
  const protocol=registerHistoricalProtocol(req,catalogue,exposure,at);
  const plan={schemaVersion:1,format:'v1-historical-import-plan-v1',reviewedAt:at,protocolFingerprint:protocol.fingerprint,syntheticOnly:true,
    canonicalBaseIds:candidates.slice(0,5).map(m=>m.matchId),maps:candidates.slice(5).map(m=>({matchId:m.matchId,payloadSha256:'a'.repeat(64)})),
    historyWindow:{fromAt:request.fromAt,toAt:request.toAt,maxMaps:request.maxMaps},collectionReport:{protocolFingerprint:protocol.fingerprint,
      rows:[{matchId:'6',seriesId:'6',exposureExcluded:false,reasons:[]},{matchId:'7',seriesId:'7',exposureExcluded:true,reasons:['PRIOR_EXPOSURE_WHOLE_SERIES']},
        {matchId:'8',seriesId:'8',exposureExcluded:false,reasons:[]}]}};
  mutate({source,plan});const dataset=prepareV1Data(source),importPlan=stamp(plan);
  const capsule=stamp({schemaVersion:1,format:'v1-historical-execution-input-v1',preparedAt:registered,
    protocol:evidence(protocol),catalogue:evidence(catalogue),exposure:evidence(exposure),importPlan:evidence(importPlan),dataset:evidence(dataset),
    coverage:reconcileHistoricalImport(importPlan,dataset)});
  const context=verifyHistoricalCapsule(capsule),capsuleSha=sha(text(capsule)),freeze=registerHistoricalFreeze(context,capsuleSha,code,runtime,registered);
  const freezeSha=sha(text(freeze)),start={schemaVersion:1,format:'v1-historical-first-scoring-v1',startedAt:registered,freezeSha256:freezeSha,freezeFingerprint:freeze.fingerprint,capsuleSha256:capsuleSha};
  return {context,capsule,freeze,capsuleSha,freezeSha,start};
}
const score=f=>scoreHistoricalEvaluation(f.context,f.freeze,f.freezeSha,f.start);
test('historical freeze follows actual evidence clocks and does not score or relax numeric gates',()=>{
  const f=fixture();assert(f.freeze.registeredAt>f.context.protocol.request.events[0].until);
  assert.equal(f.freeze.complete,true);assert.equal(f.freeze.activation,'separate_gate_required');
  assert.equal(f.context.coverage.qualityGateCalculated,false);assert.equal(historicalCandidate(f.context.protocol).isActive,false);
  assert.deepEqual(verifyHistoricalFreeze(f.freeze,f.context,f.capsuleSha,code,runtime),f.freeze);
  assert.throws(()=>registerHistoricalFreeze(f.context,f.capsuleSha,code,runtime,at),/registration_clock/);
});
test('dataset, ledger, code, runtime and policy substitutions are rejected even with recomputed hashes',()=>{
  const f=fixture();
  for(const [codes,rt] of [[code.slice(1),runtime],[code.map((c,i)=>i?c:{...c,sha256:'d'.repeat(64)}),runtime],[code,{...runtime,node:'v22.16.0'}]])
    assert.throws(()=>verifyHistoricalFreeze(f.freeze,f.context,f.capsuleSha,codes,rt));
  assert.throws(()=>verifyHistoricalFreeze(f.freeze,f.context,'f'.repeat(64),code,runtime),/freeze_replay/);
  const bad=structuredClone(f.capsule);bad.coverage.rows.pop();delete bad.fingerprint;assert.throws(()=>verifyHistoricalCapsule(stamp(bad)),/coverage_replay/);
  const p=structuredClone(f.context.protocol);p.qualityPolicy.scoring.maxBrier=1;assert.throws(()=>historicalCandidate(p),/numeric_policy/);
  const raw=structuredClone(f.capsule);raw.dataset.text+=' ';delete raw.fingerprint;assert.throws(()=>verifyHistoricalCapsule(stamp(raw)),/source_sha/);
});
test('canonical numeric team ordering swaps sides and labels together; exposed target is absent from denominator',()=>{
  const f=fixture(),r=score(f);assert.deepEqual(r.rows.map(x=>x.matchId),['6','8']);assert.equal(r.metricDiagnostic.coverage.observedMaps,2);
  assert.equal(r.exposureExcludedMaps,1);assert.equal(r.features[0].teamAId,'11');assert.equal(r.rows[0].teamAWon,true);
  assert.equal(r.features[0].result.scenario.teamA[0].accountId,'105');
  assert.equal(r.qualityDecision,'insufficient_evidence');assert.equal(r.releaseGatePassed,false);assert.equal(r.teamAWinProbability,null);
});
test('target and future label changes cannot change an earlier prediction; completed earlier maps may update later ones',()=>{
  const f=fixture(),a=score(f),g=fixture(({source})=>{for(const i of [5,7]){source.candidates[i].radiantWin=!source.candidates[i].radiantWin;source.candidates[i].outcome.teamAWon=source.candidates[i].radiantWin;}}),b=score(g);
  assert.equal(a.rows[0].probability,b.rows[0].probability);assert.notEqual(a.rows[0].teamAWon,b.rows[0].teamAWon);
  assert.notEqual(a.rows[1].probability,b.rows[1].probability);
  for(const row of a.features)assert(!row.result.history.usedMatchIds.includes(row.matchId));
});
test('a missing sibling stays in denominator and excludes the whole known series',()=>{
  const f=fixture(({plan})=>plan.collectionReport.rows.push({matchId:'9',seriesId:'6',exposureExcluded:false,reasons:['DETAIL_MISSING']})),r=score(f);
  assert.equal(r.metricDiagnostic.coverage.observedMaps,3);assert.deepEqual(r.rows.map(r=>r.matchId),['8']);
  assert(r.ledger.find(r=>r.matchId==='6').reasons.includes('SERIES_NOT_READY'));
});
test('a completion exactly at target start is excluded; exposed maps cannot be relabeled as clean targets',()=>{
  const f=fixture(({source})=>{source.candidates[4].endedAtUs=source.candidates[5].startedAtUs;
    source.candidates[4].outcome.completedAt=source.candidates[5].outcome.startedAt;}),r=score(f);
  assert.deepEqual(r.rows.map(x=>x.matchId),['8']);assert.equal(r.ledger.find(x=>x.matchId==='6').disposition,'excluded');
  assert.throws(()=>fixture(({plan})=>{plan.collectionReport.rows[1].exposureExcluded=false;plan.collectionReport.rows[1].reasons=[];}),/exposure_binding/);
});
test('zero eligible targets has null metrics and does not fabricate a 50/50 result',()=>{
  const f=fixture(({source})=>source.identities=[]),r=score(f);assert.equal(r.rows.length,0);assert.equal(r.metricDiagnostic.metrics,null);assert.equal(r.releaseGatePassed,false);
});
test('freeze or first-scoring binding tampering cannot initiate scoring',()=>{
  const f=fixture();for(const changed of [{...f.start,startedAt:at},{...f.start,freezeSha256:'e'.repeat(64)},{...f.start,freezeFingerprint:'e'.repeat(64)}])
    assert.throws(()=>scoreHistoricalEvaluation(f.context,f.freeze,f.freezeSha,changed),/scoring_binding/);
});
test('registry handoff replays report and refuses forged passed flags, metrics and probabilities',()=>{
  const f=fixture(),r=score(f),binding=historicalRegistryBinding(f.context,f.freeze,f.freezeSha,r);
  assert.equal(binding.eligibleForActivation,false);assert.equal(binding.legacyRegistryCompatible,false);assert.equal(binding.deployable,false);
  for(const mutate of [x=>x.releaseGatePassed=true,x=>x.rows[0].probability=0.99,x=>x.metricDiagnostic.metrics.brier=0]){
    const x=structuredClone(r);mutate(x);delete x.fingerprint;assert.throws(()=>historicalRegistryBinding(f.context,f.freeze,f.freezeSha,stamp(x)),/evaluation_replay/);
  }
});
async function testWorkspaceDependencies(root){
  // Synthetic executable fixture: real immutable installed third-party libraries, frozen workspace modules.
  for(const name of ['contracts','analytics','prediction','db','ingestion']){
    const original=resolve('packages',name,'package.json'),pkg=JSON.parse(await readFile(original,'utf8')),require=createRequire(original);
    for(const dep of Object.keys(pkg.dependencies??{})){
      let target;
      if(dep.startsWith('@dota/'))target=join(root,'packages',dep.slice(6));
      else{
        target=dirname(require.resolve(dep));
        while(true){try{if(JSON.parse(await readFile(join(target,'package.json'),'utf8')).name===dep)break;}catch{}
          const parent=dirname(target);if(parent===target)throw Error('test_dependency_missing');target=parent;}
      }
      const link=join(root,'packages',name,'node_modules',dep);await mkdir(dirname(link),{recursive:true});
      await symlink(target,link,process.platform==='win32'?'junction':'dir');
    }
  }
}
test('bundled code verifies independently; wrong source SHA, modified file and execution outside bundle fail',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'dota-historical-freeze-')),out=join(temp,'bundle');
  try{
    const f=fixture(),actualCode=await releaseExecutionCode(),actualRuntime=await releaseRuntime();
    const freeze=registerHistoricalFreeze(f.context,f.capsuleSha,actualCode,actualRuntime,registered);
    const manifest=await saveHistoricalBundle(out,f.capsule,text(f.capsule),freeze,actualCode);
    const bundle=await loadHistoricalBundle(out,manifest.freezeSha256,manifest.capsuleSha256);
    assert.equal(bundle.freeze.fingerprint,freeze.fingerprint);
    await assert.rejects(evaluateHistoricalBundle(bundle),/run_from_frozen_bundle/);
    await assert.rejects(saveHistoricalBundle(out,f.capsule,text(f.capsule),freeze,actualCode),/EEXIST/);
    await assert.rejects(loadHistoricalBundle(out,'0'.repeat(64),manifest.capsuleSha256));
    await testWorkspaceDependencies(out);
    const run=mode=>spawnSync(process.execPath,[join(out,'scripts/historical-v1.mjs'),mode,out,manifest.freezeSha256,manifest.capsuleSha256],{encoding:'utf8',timeout:60000});
    const first=run('evaluate');assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(first.stdout).releaseGatePassed,false);
    const again=run('evaluate');assert.equal(again.status,1);assert.equal(JSON.parse(again.stderr).code,'OUTPUT_EXISTS');
    const replay=run('replay');assert.equal(replay.status,0,replay.stderr);
    const receipt=JSON.parse(await readFile(join(out,'evaluation/started.json'),'utf8'));receipt.startedAt=at;
    await writeFile(join(out,'evaluation/started.json'),text(receipt));const bad=run('replay');assert.equal(bad.status,1);assert.match(bad.stderr,/FIRST_RECEIPT_CHANGED/);
    await writeFile(join(out,'scripts/historical-v1.mjs'),'throw Error("changed");');
    await assert.rejects(loadHistoricalBundle(out,manifest.freezeSha256,manifest.capsuleSha256),/freeze_replay/);
  }finally{assert(resolve(temp).startsWith(resolve(tmpdir())+ '\\')||resolve(temp).startsWith(resolve(tmpdir())+'/'));await rm(temp,{recursive:true,force:true});}
});
test('CLI usage failure is safe and does not disclose file contents',()=>{
  const result=spawnSync(process.execPath,['scripts/historical-v1.mjs','verify'],{encoding:'utf8'});assert.equal(result.status,2);assert.match(result.stderr,/Использование/);
});
