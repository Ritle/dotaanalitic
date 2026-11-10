import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,sep} from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fixture,text,evidence,stamp,code,runtime,preparedAt} from '../helpers/retest-execution.mjs';
import {verifyRetestCapsule,registerRetestFreeze,verifyRetestFreeze,scoreRetestEvaluation,retestRegistryBinding,
  retestExecutionCoverage,prepareRetestCapsule} from '../../scripts/lib/v1-retest-execution.mjs';
import {saveRetestBundle,loadRetestBundle,evaluateRetestBundle} from '../../scripts/lib/v1-retest-bundle.mjs';
import {releaseExecutionCode,releaseRuntime} from '../../scripts/lib/v1-release-files.mjs';
import {sha} from '../../scripts/lib/v1-retest-protocol.mjs';
const score=f=>scoreRetestEvaluation(f.context,f.freeze,f.freezeSha,f.start);
const restamp=c=>stamp(c),replace=(c,key,mutate)=>{const v=JSON.parse(c[key].text);mutate(v);c[key]=evidence(stamp(v));};

test('provider side evidence binds discovery without equating provider and canonical team IDs',()=>{
 const f=fixture(({source})=>{
  const id=v=>v==='1'?'501':v==='2'?'902':v;
  for(const m of source.candidates){m.radiantTeamId=id(m.radiantTeamId);m.direTeamId=id(m.direTeamId);m.outcome.teamAId=id(m.outcome.teamAId);m.outcome.teamBId=id(m.outcome.teamBId);}
  for(const a of source.aliases){a.teamAId=id(a.teamAId);a.teamBId=id(a.teamBId);}
 });
 assert.equal(f.context.coverage.summary.readyMaps,3);
 assert.equal(f.context.dataset.source.candidates[5].radiantTeamId,'501');
 assert.equal(f.context.plan.maps[0].providerContext.radiantTeamId,'1');
});

test('changed, swapped or absent provider side evidence cannot enter a freeze',()=>{
 for(const mutate of [v=>{v.maps[0].providerContext.radiantTeamId='999';},
  v=>{const p=v.maps[0].providerContext;[p.radiantTeamId,p.direTeamId]=[p.direTeamId,p.radiantTeamId];},
  v=>{delete v.maps[0].providerContext;}]){
  const c=structuredClone(fixture().capsule);replace(c,'importPlan',mutate);
  c.coverage=retestExecutionCoverage(JSON.parse(c.importPlan.text),JSON.parse(c.dataset.text));
  assert.throws(()=>verifyRetestCapsule(restamp(c)),/target_context/);
 }
});

test('v2 preparation freezes all targets and previous FAIL without scoring or activation',()=>{
  const f=fixture();assert.equal(f.context.coverage.summary.targetMaps,4);assert.equal(f.context.coverage.summary.readyMaps,3);
  assert.equal(f.context.coverage.metrics,null);assert.equal(f.context.coverage.evaluationPerformed,false);
  assert.equal(f.freeze.previousReportSha256,f.context.protocol.previousAttempt.reportSha256);
  assert.equal(f.freeze.qualityPolicySha256,f.context.inputs.previous.protocol.qualityPolicySha256);
  assert.deepEqual(verifyRetestFreeze(f.freeze,f.context,f.capsuleSha,code,runtime),f.freeze);
  assert.throws(()=>registerRetestFreeze(f.context,f.capsuleSha,code,runtime,'2025-11-06T12:00:00.000Z'),/registration_clock/);
});
test('portable protocol sources reject missing, duplicate, changed and unbound bytes',()=>{
  for(const mutate of [c=>c.protocolSources.pop(),c=>c.protocolSources.push(c.protocolSources[0]),
    c=>c.protocolSources[0].text+=' ',c=>c.protocolSources.push(evidence({unbound:true}))]){
    const c=structuredClone(fixture().capsule);mutate(c);assert.throws(()=>verifyRetestCapsule(restamp(c)),/source/);
  }
});
test('first failure and numeric policy cannot be changed even with refreshed fingerprints',()=>{
  for(const mutate of [p=>p.previousAttempt.reportSha256='0'.repeat(64),p=>p.qualityPolicy.model.k=16,
    p=>p.qualityPolicy.scoring.maxBrier=1,p=>p.syntheticOnly=false]){
    const c=structuredClone(fixture().capsule);replace(c,'protocol',mutate);assert.throws(()=>verifyRetestCapsule(restamp(c)),/protocol_replay/);
  }
});
test('closure, source manifest, import plan and dataset are inseparably bound',()=>{
  for(const [key,mutate] of [['closure',v=>v.report.collection.terminal=false],['sourceManifest',v=>v.stateFingerprint='0'.repeat(64)],
    ['importPlan',v=>v.closureFingerprint='0'.repeat(64)],['importPlan',v=>v.syntheticOnly=false],
    ['dataset',v=>v.source.request.toAt='2025-08-01T00:00:00.000Z']]){
    const c=structuredClone(fixture().capsule);replace(c,key,mutate);assert.throws(()=>verifyRetestCapsule(restamp(c)));
  }
});
test('open collection and duplicate, missing or relabelled targets cannot enter a freeze',()=>{
  for(const mutate of [({report})=>report.collection.terminal=false,({report})=>report.rows.pop(),
    ({report})=>report.rows.push(report.rows[0]),({report})=>report.rows[0].exposureExcluded=false,
    ({report})=>report.rows[3].seriesId='99'])assert.throws(()=>fixture(mutate),/closure_binding|target_inventory|target_binding/);
});
test('unknown series may be resolved; new exclusions must follow verified exposure of the complete series',()=>{
  const f=fixture(({report})=>{const row=report.rows.find(r=>r.matchId==='100000006');row.seriesId='30';row.exposureExcluded=true;
    row.reasons=['PRIOR_EXPOSURE_WHOLE_SERIES'];});
  assert.equal(f.context.coverage.summary.targetMaps,3);
  assert.throws(()=>fixture(({report})=>{const row=report.rows.find(r=>r.matchId==='100000006');row.seriesId='33';row.exposureExcluded=true;
    row.reasons=['PRIOR_EXPOSURE_WHOLE_SERIES'];}),/exposure_binding/);
  assert.throws(()=>fixture(({report})=>{report.rows[3].exposureExcluded=true;report.rows[3].reasons=['PRIOR_EXPOSURE_WHOLE_SERIES'];}),/exposure_binding/);
});
test('unknown series in prior exposure cannot connect unrelated unknown target maps',()=>{
  const f=fixture(()=>{},{unknownExposedSeries:true});
  assert.equal(f.context.coverage.summary.targetMaps,4);
  assert.equal(f.context.coverage.rows.find(r=>r.matchId==='100000006').exposureExcluded,false);
});
test('missing sibling excludes the complete series while preserving unknown and missing denominators',()=>{
  const f=fixture(({source})=>{source.candidates=source.candidates.filter(m=>m.matchId!=='100000005');}),r=score(f);
  assert.equal(r.ledger.length,4);assert.deepEqual(r.rows.map(r=>r.matchId),['100000007']);
  assert(r.ledger.filter(r=>r.seriesKey==='opendota:32').every(r=>r.disposition==='excluded'));
  assert.equal(r.ledger.find(r=>r.matchId==='100000006').seriesKey,null);
});
test('target/future labels cannot leak; numeric team order swaps the label and lineup together',()=>{
  const a=score(fixture()),b=score(fixture(({source})=>{for(const m of source.candidates.slice(5)){m.radiantWin=!m.radiantWin;m.outcome.teamAWon=m.radiantWin;}}));
  assert.deepEqual(a.rows.map(r=>r.probability),b.rows.map(r=>r.probability));
  assert.notEqual(a.rows[0].teamAWon,b.rows[0].teamAWon);
  const swapped=a.features.find(f=>f.matchId==='100000005');assert.equal(swapped.teamAId,'1');assert.equal(swapped.result.scenario.teamA[0].accountId,'105');
  for(const f of a.features)assert(f.result.history.usedMatchIds.every(id=>BigInt(id)<100000000n));
  assert.equal(a.releaseGatePassed,false);assert.equal(a.syntheticOnly,true);assert.equal(a.deployable,false);
});
test('completion exactly at target cutoff is excluded, insufficient sample produces no invented metrics',()=>{
  const f=fixture(({source})=>{const m=source.candidates[4],target=source.candidates[5];m.endedAtUs=target.startedAtUs;m.outcome.completedAt=target.outcome.startedAt;}),r=score(f);
  assert.equal(r.rows.length,0);assert.equal(r.releaseGatePassed,false);assert.equal(r.teamAWinProbability,null);
  assert.equal(r.metricDiagnostic.metrics,null);
});
test('discovery conflicts and changed canonical context cannot be scored',()=>{
  const f=fixture(),plan=structuredClone(f.context.plan);plan.historyConflictMapIds=['1'];
  assert.throws(()=>retestExecutionCoverage(plan,f.context.dataset),/history_discovery_conflict/);
  assert.throws(()=>fixture(({source})=>{source.candidates[5].startedAtUs=String(BigInt(source.candidates[5].startedAtUs)+1000000n);source.candidates[5].outcome.startedAt='2025-02-10T00:00:01.000Z';}),/target_context/);
});
test('code/runtime/source substitution and changed scoring receipts or passed assertions fail',()=>{
  const f=fixture();for(const [c,r] of [[code.slice(1),runtime],[code,{...runtime,node:'v22.16.0'}]])assert.throws(()=>verifyRetestFreeze(f.freeze,f.context,f.capsuleSha,c,r));
  assert.throws(()=>scoreRetestEvaluation(f.context,f.freeze,f.freezeSha,{...f.start,freezeSha256:'0'.repeat(64)}),/scoring_binding/);
  assert.throws(()=>scoreRetestEvaluation(f.context,{...f.freeze,previousReportSha256:'0'.repeat(64)},f.freezeSha,f.start),/freeze_replay/);
  const report=score(f),binding=retestRegistryBinding(f.context,f.freeze,f.freezeSha,report);assert.equal(binding.eligibleForActivation,false);
  assert.equal(binding.legacyRegistryCompatible,false);assert.equal(binding.isActive,false);
  assert.throws(()=>retestRegistryBinding(f.context,f.freeze,f.freezeSha,stamp({...report,releaseGatePassed:true})),/evaluation_replay/);
});

async function dependencies(root){
  for(const name of ['contracts','analytics','prediction','db','ingestion']){
    const original=resolve('packages',name,'package.json'),pkg=JSON.parse(await readFile(original,'utf8')),require=createRequire(original);
    for(const dep of Object.keys(pkg.dependencies??{})){
      let target;if(dep.startsWith('@dota/'))target=join(root,'packages',dep.slice(6));
      else{target=dirname(require.resolve(dep));while(true){try{if(JSON.parse(await readFile(join(target,'package.json'),'utf8')).name===dep)break;}catch{}
        const parent=dirname(target);if(parent===target)throw Error('test_dependency_missing');target=parent;}}
      const link=join(root,'packages',name,'node_modules',dep);await mkdir(dirname(link),{recursive:true});await symlink(target,link,process.platform==='win32'?'junction':'dir');
    }
  }
}
test('frozen v2 CLI evaluates and replays once; prior receipt/code cannot be overwritten',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'dota-retest-execution-')),out=join(temp,'bundle');
  try{
    const f=fixture(),actualCode=await releaseExecutionCode(),freeze=registerRetestFreeze(f.context,f.capsuleSha,actualCode,await releaseRuntime(),preparedAt);
    const manifest=await saveRetestBundle(out,f.capsule,text(f.capsule),freeze,actualCode);
    const bundle=await loadRetestBundle(out,manifest.freezeSha256,manifest.capsuleSha256);
    await assert.rejects(evaluateRetestBundle(bundle),/run_from_frozen_bundle/);
    await assert.rejects(saveRetestBundle(out,f.capsule,text(f.capsule),freeze,actualCode),/EEXIST/);
    await dependencies(out);
    const run=mode=>spawnSync(process.execPath,[join(out,'scripts/retest-v1.mjs'),mode,out,manifest.freezeSha256,manifest.capsuleSha256],{encoding:'utf8',timeout:60000});
    const first=run('evaluate');assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(first.stdout).releaseGatePassed,false);
    assert.equal(JSON.parse(run('evaluate').stderr).code,'OUTPUT_EXISTS');
    const replay=run('replay');assert.equal(replay.status,0,replay.stderr);
    const receipt=JSON.parse(await readFile(join(out,'evaluation/started.json'),'utf8'));receipt.startedAt=preparedAt;
    await writeFile(join(out,'evaluation/started.json'),text(receipt));assert.match(run('replay').stderr,/FIRST_RECEIPT_CHANGED/);
    await writeFile(join(out,'scripts/lib/v1-retest-execution.mjs'),'throw Error("modified");');
    await assert.rejects(loadRetestBundle(out,manifest.freezeSha256,manifest.capsuleSha256),/freeze_replay/);
  }finally{assert(resolve(temp).startsWith(resolve(tmpdir())+sep));await rm(temp,{recursive:true,force:true});}
});
test('production prepare refuses an open collection before output, provider calls or dataset access',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'dota-retest-open-'));
  try{
    const store=join(temp,'store');await mkdir(store);
    const header=stamp({schemaVersion:2,format:'retest-source-collection-v2'});await writeFile(join(store,'collection.json'),text(header));
    const missing={path:join(temp,'missing.json'),sha256:'a'.repeat(64)};
    const config={schemaVersion:2,collection:{directory:store,sha256:sha(text(header))},sourceManifest:missing,heroes:missing,registry:missing,profiles:[]};
    const configPath=join(temp,'import.json');await writeFile(configPath,text(config));
    const plan={schemaVersion:2,format:'v1-retest-import-plan-v2',reviewedAt:preparedAt,config:{path:configPath,sha256:sha(text(config))}};
    const path=join(temp,'plan.json');await writeFile(path,text(plan));
    const execute={schemaVersion:2,importPlan:{path,sha256:sha(text(plan))},dataset:missing},file=join(temp,'execute.json');await writeFile(file,text(execute));
    await assert.rejects(prepareRetestCapsule(file,sha(text(execute))),/collection_not_closed/);
    const output=join(temp,'bundle'),cli=spawnSync(process.execPath,['scripts/retest-v1.mjs','freeze',file,sha(text(execute)),output],{encoding:'utf8'});
    assert.equal(cli.status,1);assert.match(cli.stderr,/RETEST_IMPORT_COLLECTION_NOT_CLOSED/);await assert.rejects(access(output));
  }finally{assert(resolve(temp).startsWith(resolve(tmpdir())+sep));await rm(temp,{recursive:true,force:true});}
});
