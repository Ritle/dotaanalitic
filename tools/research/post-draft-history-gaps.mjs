import {readFile,writeFile} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CaptureSchema,boundedJson,digest,sha} from './post-draft-dataset.mjs';
import {prepareV1PerMapFeatureHistory} from '../../packages/db/dist/index.js';
import {createV1FeatureBuilder,V1_FEATURE_POLICY} from '../../packages/prediction/dist/index.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const cmp=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const unique=(rows,key)=>{const m=new Map(rows.map(r=>[r[key],r]));if(m.size!==rows.length)throw Error('duplicate_'+key);return m;};
const iso=us=>new Date(Number(BigInt(us)/1000n)).toISOString();

export function historySeriesKey(datasetKey){
 const tuple=JSON.parse(datasetKey);
 if(!Array.isArray(tuple)||tuple.length!==2||tuple[0]!=='opendota'||typeof tuple[1]!=='string'||!/^[1-9]\d*$/.test(tuple[1]))throw Error('unverified_series_namespace');
 return 'opendota:'+tuple[1];
}

/** Uses the frozen production feature builder, never a nickname or inferred organization roster. */
export function diagnoseHistoryGaps(history,targets){
 const byMap=unique(history.maps,'matchId'),builder=createV1FeatureBuilder(history);
 unique(targets,'matchId');
 const rows=targets.map(target=>{
  const map=byMap.get(target.matchId);
  if(!map||map.startedAtUs!==target.cutoffAtUs||map.seriesKey!==target.seriesKey||map.outcomeReceiptId!==target.receiptId||
   !/^[1-9]\d*$/.test(target.radiantTeamId)||!/^[1-9]\d*$/.test(target.direTeamId)||target.radiantTeamId===target.direTeamId)throw Error('target_binding');
  if(target.datasetSeriesKey!==undefined&&historySeriesKey(target.datasetSeriesKey)!==map.seriesKey)throw Error('dataset_series_binding');
  const aRadiant=BigInt(target.radiantTeamId)<BigInt(target.direTeamId);
  const result=builder({schemaVersion:1,targetMatchId:map.matchId,cutoffAtUs:map.startedAtUs,
   teamA:aRadiant?map.teamA:map.teamB,teamB:aRadiant?map.teamB:map.teamA,
   lineup:{basis:'actual_lineup_reconstructed',source:'verified-map-receipt:'+map.outcomeReceiptId,
    selectedAtUs:map.fetchedAtUs,revision:history.sourceFingerprint}});
  if(result.status!=='unavailable'||result.reasons.length!==1||result.reasons[0]!=='INSUFFICIENT_PLAYER_HISTORY')throw Error('gap_reason_changed');
  const used=result.history.usedMatchIds.map(id=>{
   const prior=byMap.get(id);
   if(!prior||id===map.matchId||BigInt(prior.startedAtUs)>=BigInt(map.startedAtUs)||BigInt(prior.completedAtUs)>=BigInt(map.startedAtUs))throw Error('future_history');
   return prior;
  });
  const players=[['A',result.teamA],['B',result.teamB]].flatMap(([team,members])=>members.map(p=>{
   if(p.reason!==null||!p.identityProofIds.length)throw Error('identity_not_verified');
   const ids=used.filter(m=>[...m.teamA,...m.teamB].some(x=>x.playerId===p.playerId&&x.accountId===p.accountId)).map(m=>m.matchId).sort(cmp);
   if(ids.length!==p.maps)throw Error('history_count_mismatch');
   return {team,playerId:p.playerId,accountId:p.accountId,identityProofIds:p.identityProofIds,
    priorMaps:p.maps,missingToMinimum:Math.max(0,V1_FEATURE_POLICY.minCompletedProMapsPerPlayer-p.maps),priorMatchIds:ids};
  }));
  return {matchId:map.matchId,seriesKey:map.seriesKey,datasetSeriesKey:target.datasetSeriesKey??null,cutoffAtUs:map.startedAtUs,cutoffAt:iso(map.startedAtUs),
   teamASide:aRadiant?'radiant':'dire',players};
 }).sort((a,b)=>cmp(a.cutoffAtUs,b.cutoffAtUs)||cmp(a.matchId,b.matchId));
 const accounts=new Map();
 for(const row of rows)for(const p of row.players.filter(p=>p.missingToMinimum>0)){
  let item=accounts.get(p.accountId);
  if(item&&item.playerId!==p.playerId)throw Error('account_identity_conflict');
  if(!item){item={accountId:p.accountId,playerId:p.playerId,identityProofIds:[],targets:[]};accounts.set(p.accountId,item);}
  item.identityProofIds=[...new Set([...item.identityProofIds,...p.identityProofIds])].sort();
  item.targets.push({matchId:row.matchId,seriesKey:row.seriesKey,cutoffAt:row.cutoffAt,cutoffAtUs:row.cutoffAtUs,
   priorMaps:p.priorMaps,missingToMinimum:p.missingToMinimum,priorMatchIds:p.priorMatchIds});
 }
 const requests=[...accounts.values()].map(a=>({...a,affectedMaps:a.targets.length,
  affectedSeries:new Set(a.targets.map(t=>t.seriesKey)).size,earliestCutoffAt:a.targets[0].cutoffAt,
  earliestCutoffAtUs:a.targets[0].cutoffAtUs,latestCutoffAt:a.targets.at(-1).cutoffAt,
  requiredBeforeEarliestCutoff:a.targets[0].missingToMinimum,
  discoveryFromAt:iso(history.warmupFromAtUs),discoveryUntilExclusive:a.targets.at(-1).cutoffAt,
  remoteAvailability:'unknown'})).sort((a,b)=>cmp(a.earliestCutoffAtUs,b.earliestCutoffAtUs)||cmp(a.accountId,b.accountId));
 const firstBatch=requests.slice(0,20);
 return {format:'post-draft-history-gap-audit-v1',scope:'retrospective_same_account_completed_strict',
  historyFingerprint:history.sourceFingerprint,identityRevision:history.identityRevision,
  minimumPriorMaps:V1_FEATURE_POLICY.minCompletedProMapsPerPlayer,rows,accounts:requests,
  counts:{targetMaps:rows.length,targetSeries:new Set(rows.map(r=>r.seriesKey)).size,distinctDeficientAccounts:requests.length,
   deficientPlayerMapSlots:requests.reduce((n,a)=>n+a.targets.length,0),
   summedSlotDeficit:requests.reduce((n,a)=>n+a.targets.reduce((s,t)=>s+t.missingToMinimum,0),0)},
  collectionProposal:{status:'not_registered_not_executed',ordering:'earliest_target_cutoff_then_numeric_account_id',
   accountIds:firstBatch.map(a=>a.accountId),deferredAccountIds:requests.slice(20).map(a=>a.accountId),
   maxAccounts:20,maxDiscoveryAttemptsPerAccount:2,maxDiscoveryAttempts:firstBatch.length*2,maxDetailAttempts:100,
   maxTotalHttpAttempts:firstBatch.length*2+100,retriesConsumeBudget:true,
   requiredGuards:['reuse_fresh_cache','global_map_id_dedup','skip_verified_stored_details','provider_quota_and_retry_after',
    'positive_pro_evidence','verified_same_account','strict_completion_before_each_target','new_dataset_revision','no_training_or_activation'],
   summedDeficitIsNotUniqueMissingMaps:true,completeness:'unknown'},
  syntheticOnly:history.syntheticOnly,providerHttpRequests:0,trainingPerformed:false,deployable:false};
}

export function auditHistoryGaps(dataset,captureInput){
 const capture=CaptureSchema.parse(captureInput);
 if(dataset.protocolFingerprint!==capture.protocolFingerprint||dataset.deployable!==false)throw Error('dataset_capture_binding');
 for(const k of ['initialRating','k','scale','minCompletedProMapsPerPlayer'])if(dataset.policy.history[k]!==V1_FEATURE_POLICY[k])throw Error('policy_changed');
 unique(dataset.rows,'matchId');
 const source=unique(capture.source.candidates,'matchId');
 const history=prepareV1PerMapFeatureHistory(capture.source);
 if(history.sourceFingerprint!==dataset.history.fingerprint)throw Error('history_changed');
 const late=dataset.rows.filter(r=>r.nominalWindow==='development_test');
 const targets=late.filter(r=>r.reasons.includes('INSUFFICIENT_PLAYER_HISTORY')).map(r=>{
  const m=source.get(r.matchId);
  if(!m||m.isPro!==true||m.outcome.status!=='verified'||r.pairedEligible||r.baselineEligible)throw Error('target_not_excluded_verified_pro');
  return {matchId:m.matchId,seriesKey:historySeriesKey(r.seriesKey),datasetSeriesKey:r.seriesKey,cutoffAtUs:m.startedAtUs,receiptId:m.outcome.outcomeReceiptId,
   radiantTeamId:m.outcome.teamAId,direTeamId:m.outcome.teamBId};
 });
 return {...diagnoseHistoryGaps(history,targets),sourceCohort:{planned:late.length,paired:late.filter(r=>r.pairedEligible).length,
  excluded:late.filter(r=>!r.pairedEligible).length,unexaminedExclusions:late.filter(r=>!r.pairedEligible&&!r.reasons.includes('INSUFFICIENT_PLAYER_HISTORY')).map(r=>({matchId:r.matchId,reasons:r.reasons}))}};
}

async function main(){
 const [mode,evalDirectory,datasetPath,capturePath,output,...extra]=process.argv.slice(2);
 if(!['audit','verify'].includes(mode)||!output||extra.length)throw Error('arguments');
 const out=resolve(output),rel=relative(join(root,'.tools'),out);
 if(!rel||rel.startsWith('..')||rel.includes(':'))throw Error('output_outside_tools');
 const [manifest,dataset,capture]=await Promise.all([boundedJson(join(evalDirectory,'manifest.json')),boundedJson(datasetPath),boundedJson(capturePath)]);
 if(dataset.sha256!==manifest.value.sourceHashes.dataset||capture.sha256!==dataset.value.inputs.captureSha256||capture.value.source.syntheticOnly)throw Error('source_sha');
 const {fingerprint,...body}=dataset.value;if(digest(body)!==fingerprint)throw Error('dataset_fingerprint');
 for(const entry of manifest.value.code){
  const path=resolve(root,entry.path),r=relative(root,path);
  if(r.startsWith('..')||r.includes(':')||sha(await readFile(path))!==entry.sha256)throw Error('frozen_code_changed');
 }
 const result={...auditHistoryGaps(dataset.value,capture.value),sourceHashes:{evaluationManifest:manifest.sha256,dataset:dataset.sha256,capture:capture.sha256},
  auditCodeSha256:sha(await readFile(fileURLToPath(import.meta.url)))};
 if(mode==='verify'){if(digest((await boundedJson(out)).value)!==digest(result))throw Error('audit_replay_mismatch');}
 else await writeFile(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:'PASS',counts:result.counts,sourceCohort:result.sourceCohort,providerHttpRequests:0,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(()=>{console.error('Аудит истории не выполнен. Проверьте SHA источников, код и отдельный путь результата.');process.exitCode=1;});
}
