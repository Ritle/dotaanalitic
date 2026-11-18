import {readFile,writeFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {createDatabase,V1DataRepository,sql,prepareV1PerMapFeatureHistory,resolveIdentity} from '../../packages/db/dist/index.js';
import {createV1FeatureBuilder,V1_FEATURE_POLICY} from '../../packages/prediction/dist/index.js';
import {boundedJson,datasetCode,digest,sha} from './post-draft-dataset.mjs';
import {auditHistoryGaps} from './post-draft-history-gaps.mjs';
const paths={proposal:'docs/evidence/s3-04-history-coverage-check-proposal.json',baseline:'.tools/s304-dataset-capture-final.json',dataset:'.tools/s304-dataset-final.json',gaps:'.tools/s304-history-gaps-r1.json',plan:'.tools/s304-history-import-plan.json',manifest:'.tools/s304-history-import-apply-r1/manifest.json',importReport:'.tools/s304-history-import-apply-r1/report.json',source:'.tools/s304-history-coverage-source-r1.json',output:'.tools/s304-history-coverage-r2.json'};
async function inputs(){
 const loaded=Object.fromEntries(await Promise.all(Object.entries(paths).filter(([k])=>!['source','output'].includes(k)).map(async([k,p])=>[k,await boundedJson(p)])));
 assert.equal(loaded.manifest.sha256,loaded.proposal.value.sourceImportManifestSha256);
 assert.equal(loaded.importReport.sha256,loaded.proposal.value.sourceImportReportSha256);
 assert.equal(loaded.plan.sha256,loaded.manifest.value.sourceHashes.plan);
 assert.equal(loaded.baseline.sha256,loaded.dataset.value.inputs.captureSha256);
 assert.equal(loaded.gaps.value.sourceHashes.dataset,loaded.dataset.sha256);
 assert.equal(loaded.gaps.value.sourceHashes.capture,loaded.baseline.sha256);
 assert.equal(digest(auditHistoryGaps(loaded.dataset.value,loaded.baseline.value).rows),digest(loaded.gaps.value.rows));
 return loaded;
}
async function absent(path){try{await access(path);throw Error('output_exists');}catch(e){if(e.code!=='ENOENT')throw e;}}
async function capture(){
 await absent(paths.source);const input=await inputs(),url=new URL(process.env.DATABASE_URL);
 assert(['postgresql:','postgres:'].includes(url.protocol)&&['localhost','127.0.0.1','[::1]'].includes(url.hostname));
 const db=createDatabase(process.env.DATABASE_URL);
 try{
  const row=(await sql`SELECT i.manifest_text,c.report_text FROM history_projection_imports i JOIN history_projection_import_completions c ON c.import_id=i.id WHERE i.id=${input.importReport.value.importId}::uuid`.execute(db)).rows[0];
  assert(row);assert.equal(sha(row.manifest_text),input.manifest.sha256);assert.equal(sha(row.report_text),input.importReport.sha256);
  const code=await datasetCode();
  const exported=await new V1DataRepository(db).export({...input.baseline.value.source.request,snapshotAt:new Date().toISOString()},code);
  const result={format:'post-draft-history-coverage-source-v1',source:exported.source,code,sourceHashes:Object.fromEntries(Object.entries(input).map(([k,v])=>[k,v.sha256])),businessWrites:0,providerHttp:0};
  await writeFile(paths.source,JSON.stringify(result)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:'captured',maps:result.source.candidates.length,businessWrites:0,providerHttp:0}));
 }finally{await db.destroy();}
}
const numeric=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const sortedIds=ids=>[...ids].sort(numeric);
const index=rows=>{const m=new Map(rows.map(r=>[r.matchId,r]));assert.equal(m.size,rows.length,'duplicate_map');return m;};
/** Extract N and exact prior IDs from the unchanged builder; discard all ratings/features. */
function counts(history,targets){
 const maps=index(history.maps),builder=createV1FeatureBuilder(history);
 return targets.map(t=>{
  const map=maps.get(t.matchId);assert(map&&map.startedAtUs===t.cutoffAtUs&&map.seriesKey===t.seriesKey,'target_binding');
  const r=builder({schemaVersion:1,targetMatchId:map.matchId,cutoffAtUs:map.startedAtUs,teamA:map.teamA,teamB:map.teamB,
   lineup:{basis:'actual_lineup_reconstructed',source:'verified-map-receipt:'+map.outcomeReceiptId,selectedAtUs:map.fetchedAtUs,revision:history.sourceFingerprint}});
  const used=r.history.usedMatchIds.map(id=>{const m=maps.get(id);assert(m&&id!==map.matchId&&BigInt(m.startedAtUs)<BigInt(map.startedAtUs)&&BigInt(m.completedAtUs)<BigInt(map.startedAtUs),'future_history');return m;});
  const players=[...r.teamA,...r.teamB].map(p=>{
   assert.equal(p.reason,null,'identity_not_verified');assert(p.identityProofIds.length);
   const priorMatchIds=sortedIds(used.filter(m=>[...m.teamA,...m.teamB].some(x=>x.playerId===p.playerId&&x.accountId===p.accountId)).map(m=>m.matchId));
   assert.equal(priorMatchIds.length,p.maps,'count_reconciliation');
   return {playerId:p.playerId,accountId:p.accountId,priorMaps:p.maps,priorMatchIds};
  }).sort((a,b)=>numeric(a.accountId,b.accountId));
  assert(r.reasons.every(reason=>reason==='INSUFFICIENT_PLAYER_HISTORY'),'non_history_blocker');
  return {matchId:t.matchId,seriesKey:t.seriesKey,cutoffAtUs:t.cutoffAtUs,players,historyMinimumMet:r.reasons.length===0};
 });
}
/** Conditional coverage only, never a new dataset eligibility decision or holdout scoring. */
export function compareAddedHistory(before,current,importedIds,gaps,datasetRows){
 assert.equal(gaps.minimumPriorMaps,V1_FEATURE_POLICY.minCompletedProMapsPerPlayer,'minimum_changed');
 assert.equal(new Set(importedIds).size,importedIds.length,'duplicate_import');
 const old=index(before.maps),now=index(current.maps);index(gaps.rows);index(datasetRows);
 for(const id of importedIds)assert(!old.has(id)&&now.has(id),'import_scope');
 // Isolate the addition. Current identity changes may not silently change the old baseline.
 const baseline=counts(before,gaps.rows);
 const identityCheck=counts({...before,identities:current.identities,snapshotAtUs:current.snapshotAtUs},gaps.rows);
 assert.deepEqual(identityCheck,baseline,'baseline_identity_drift');
 for(const b of baseline){
  const original=gaps.rows.find(t=>t.matchId===b.matchId);
  assert.deepEqual(b.players,original.players.map(p=>({playerId:p.playerId,accountId:p.accountId,priorMaps:p.priorMaps,priorMatchIds:sortedIds(p.priorMatchIds)})).sort((a,b)=>numeric(a.accountId,b.accountId)),'baseline_changed');
 }
 const added=importedIds.map(id=>now.get(id));
 const augmented={...before,maps:[...before.maps,...added],identities:current.identities,snapshotAtUs:current.snapshotAtUs,
  identityRevision:current.identityRevision,sourceFingerprint:digest({baseline:before.sourceFingerprint,added,identityRevision:current.identityRevision})};
 const after=counts(augmented,gaps.rows),minimum=gaps.minimumPriorMaps,contributions=new Map(importedIds.map(id=>[id,{matchId:id,playerTargetSlots:0,targetIds:new Set()}]));
 const rows=after.map(a=>{
  const b=baseline.find(t=>t.matchId===a.matchId);
  const players=a.players.map(p=>{
   const prior=b.players.find(x=>x.playerId===p.playerId&&x.accountId===p.accountId);assert(prior);
   assert(prior.priorMatchIds.every(id=>p.priorMatchIds.includes(id)),'history_removed');
   const addedMatchIds=p.priorMatchIds.filter(id=>!prior.priorMatchIds.includes(id));
   assert(addedMatchIds.every(id=>importedIds.includes(id)),'unplanned_contribution');
   const provenAvailableBeforeTarget=[];
   for(const id of addedMatchIds){
    const m=now.get(id),entry=contributions.get(id);entry.playerTargetSlots++;entry.targetIds.add(a.matchId);
    // Local observation and verified label availability are later than the event itself.
    const historicalIdentities=current.identities.filter(e=>[e.fetchedAt,e.knownAt,e.eventAt].filter(v=>v!==null).every(v=>BigInt(Date.parse(v))*1000n<BigInt(a.cutoffAtUs)));
    const identitiesKnown=[...m.teamA,...m.teamB].every(p=>{const proof=resolveIdentity(historicalIdentities,p.accountId,null);return proof.status==='verified'&&proof.playerId===p.playerId;});
    if(identitiesKnown&&BigInt(m.fetchedAtUs)<BigInt(a.cutoffAtUs)&&BigInt(m.labelVerifiedAtUs)<BigInt(a.cutoffAtUs)&&
     m.factClocks.every(f=>[f.knownAtUs,f.fetchedAtUs,f.recordedAtUs].filter(v=>v!==null).every(v=>BigInt(v)<BigInt(a.cutoffAtUs))))provenAvailableBeforeTarget.push(id);
   }
   return {...p,beforeMaps:prior.priorMaps,afterMaps:p.priorMaps,missingBefore:Math.max(0,minimum-prior.priorMaps),missingAfter:Math.max(0,minimum-p.priorMaps),addedMatchIds,provenAvailableBeforeTarget};
  });
  return {matchId:a.matchId,seriesKey:a.seriesKey,cutoffAtUs:a.cutoffAtUs,cutoffAt:new Date(Number(BigInt(a.cutoffAtUs)/1000n)).toISOString(),historyMinimumMet:a.historyMinimumMet,players};
 });
 const byTarget=new Map(rows.map(r=>[r.matchId,r])),bySeries=new Map();
 for(const r of datasetRows){const key=r.seriesKey??'unknown:'+r.matchId,list=bySeries.get(key)??[];list.push(r);bySeries.set(key,list);}
 const independent=r=>r.reasons.filter(reason=>reason!=='SERIES_HAS_INELIGIBLE_DATASET_MAP'&&!(reason==='INSUFFICIENT_PLAYER_HISTORY'&&byTarget.get(r.matchId)?.historyMinimumMet));
 const late=datasetRows.filter(r=>r.nominalWindow==='development_test');
 const possible=late.filter(r=>!independent(r).length&&(bySeries.get(r.seriesKey??'unknown:'+r.matchId)??[]).every(m=>!independent(m).length));
 const recovered=possible.filter(r=>!r.pairedEligible).map(r=>r.matchId);
 const accounts=new Map();
 for(const r of rows)for(const p of r.players.filter(p=>p.missingBefore>0)){
  const group=accounts.get(p.accountId)??{accountId:p.accountId,playerId:p.playerId,slots:[]};assert.equal(group.playerId,p.playerId);
  group.slots.push({matchId:r.matchId,cutoffAt:r.cutoffAt,before:p.beforeMaps,after:p.afterMaps,missing:p.missingAfter,addedMatchIds:p.addedMatchIds});accounts.set(p.accountId,group);
 }
 const sum=(field)=>rows.reduce((n,r)=>n+r.players.reduce((k,p)=>k+p[field],0),0);
 return {format:'post-draft-history-coverage-v1',basis:'conditional_event_time_assumed_count_only',minimumPriorMaps:minimum,
  counts:{importedMaps:added.length,targetMaps:rows.length,playerTargetSlots:rows.length*10,
   deficientSlotsBefore:rows.flatMap(r=>r.players).filter(p=>p.missingBefore>0).length,deficientSlotsAfter:rows.flatMap(r=>r.players).filter(p=>p.missingAfter>0).length,
   summedDeficitBefore:sum('missingBefore'),summedDeficitAfter:sum('missingAfter'),
   targetsMeetingMinimumAfter:rows.filter(r=>r.historyMinimumMet).length,targetsStillDeficient:rows.filter(r=>!r.historyMinimumMet).length,
   originalDeficientAccounts:accounts.size,accountsStillDeficient:[...accounts.values()].filter(a=>a.slots.some(p=>p.missing>0)).length,
   improvedPlayerTargetSlots:rows.flatMap(r=>r.players).filter(p=>p.addedMatchIds.length).length,
   provenHistoricalAvailableAddedLinks:rows.flatMap(r=>r.players).reduce((n,p)=>n+p.provenAvailableBeforeTarget.length,0)},
  originalCohort:{denominator:late.length,paired:late.filter(r=>r.pairedEligible).length,excluded:late.filter(r=>!r.pairedEligible).length},
  fixedCohortCoverageOnly:{upperBoundPaired:possible.length,recoveredIds:sortedIds(recovered),coverage:late.length?possible.length/late.length:null,
   requiresNewDatasetAndAllEligibilityChecks:true,independentTest:false},
  rows,accounts:[...accounts.values()].sort((a,b)=>numeric(a.accountId,b.accountId)),
  contributions:[...contributions.values()].map(c=>({...c,targetIds:sortedIds([...c.targetIds])})).sort((a,b)=>numeric(a.matchId,b.matchId)),
  historicalAvailability:'observation_clocks_preserved; event_time_is_not_known_at; target_lineups_remain_reconstructed',
  targetProbabilitiesComputed:false,trainingPerformed:false,modelActivation:false,deployable:false};
}
async function audit(mode){
 if(mode==='audit')await absent(paths.output);
 const input=await inputs(),captured=await boundedJson(paths.source),c=captured.value;
 assert.equal(c.format,'post-draft-history-coverage-source-v1');assert.equal(c.source.syntheticOnly,false);
 assert.deepEqual(c.sourceHashes,Object.fromEntries(Object.entries(input).map(([k,v])=>[k,v.sha256])));
 for(const entry of c.code)assert.equal(sha(await readFile(entry.path)),entry.sha256,'captured_code_changed');
 const before=prepareV1PerMapFeatureHistory(input.baseline.value.source),current=prepareV1PerMapFeatureHistory(c.source);
 const ids=input.importReport.value.base.map(m=>m.matchId);assert.equal(ids.length,input.proposal.value.inputMaps);
 const plan=input.plan.value.plan;
 for(const id of ids){
  const m=c.source.candidates.find(m=>m.matchId===id),p=plan.maps.find(m=>m.matchId===id),o=input.importReport.value.outcomes.find(m=>m.matchId===id);
  assert(m?.isPro===true&&m.outcome.status==='verified'&&p&&!p.reasons.length&&o.status==='verified','import_not_verified');
  for(const k of ['outcomeReceiptId','teamAId','teamBId','teamAWon','startedAt','completedAt','dataRevision'])assert.deepEqual(m.outcome[k],o[k],'import_facts_changed');
  assert.equal(m.outcome.sourceEvidence.payloadSha256,p.projectionSha256);
  const hm=current.maps.find(m=>m.matchId===id);assert(hm,'import_not_history_eligible');
  assert.deepEqual([...hm.teamA,...hm.teamB].map(x=>[x.playerId,x.accountId]),[...p.members].sort((a,b)=>a.slot-b.slot).map(x=>[x.playerId,x.accountId]));
  assert.deepEqual([...m.players].sort((a,b)=>a.playerSlot-b.playerSlot).map(x=>[x.playerSlot,x.sourceAccountId]),[...p.members].sort((a,b)=>a.slot-b.slot).map(x=>[x.slot,x.accountId]));
 }
 const result={...compareAddedHistory(before,current,ids,input.gaps.value,input.dataset.value.rows),
  inputs:{...c.sourceHashes,currentSource:captured.sha256},sourceCounts:{baselineMaps:input.baseline.value.source.candidates.length,currentMaps:c.source.candidates.length,baselineEligibleHistory:before.maps.length,currentEligibleHistory:current.maps.length},
  auditCodeSha256:sha(await readFile(new URL(import.meta.url))),providerHttp:0,businessWrites:0};
 if(mode==='verify')assert.equal(digest((await boundedJson(paths.output)).value),digest(result),'replay_mismatch');
 else await writeFile(paths.output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:'PASS',counts:result.counts,originalCohort:result.originalCohort,fixedCohortCoverageOnly:result.fixedCohortCoverageOnly,providerHttp:0,businessWrites:0}));
}
async function main(){
 const [mode,...extra]=process.argv.slice(2);assert(!extra.length);globalThis.fetch=async()=>{throw Error('provider_http_forbidden');};
 if(mode==='capture')await capture();else if(['audit','verify'].includes(mode))await audit(mode);else throw Error('mode');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error('Coverage check failed: '+(e.code==='EEXIST'?'output_exists':'input_or_verification'));process.exitCode=1;});
