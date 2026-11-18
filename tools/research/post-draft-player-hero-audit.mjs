import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareV1PerMapFeatureHistory} from '../../packages/db/dist/index.js';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const slots=[0,1,2,3,4,128,129,130,131,132];
const numeric=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const index=rows=>{const m=new Map(rows.map(r=>[r.matchId,r]));assert.equal(m.size,rows.length,'duplicate_map');return m;};
const us=t=>(BigInt(Date.parse(t))*1000n).toString();
const key=p=>`${p.playerId}:${p.accountId}`;
function historySeriesKey(value){
 if(!value.startsWith('['))return value;
 const pair=JSON.parse(value);assert(Array.isArray(pair)&&pair.length===2&&pair.every(x=>typeof x==='string')&&/^\d+$/.test(pair[1]),'series_encoding');
 return `${pair[0]}:${pair[1]}`;
}
export const AUDIT_POLICY=Object.freeze({version:'player-hero-coverage-v1',thresholds:[1,3,5,10],recentDays:90,
 cutoff:'started_and_completed_strictly_before_target_start',scope:'same_verified_player_and_numeric_account_across_organizations',
 counts:'unweighted_local_pro_history_only',thresholdPurpose:'descriptive_not_model_gates',
 availability:'conditional_event_time_not_verified_as_of',role:'not_captured',patch:'provider_label_diagnostic_not_canonical_fallback'});

/** Reuse verified map/identity boundary, then bind final heroes to native slots and receipts. */
export function bindHeroHistory(history,source,heroes,inventory){
 const candidates=index(source.candidates),heroById=index(heroes),patches=index(inventory),maps=[],excluded=[];
 index(history.maps);
 for(const m of history.maps){
  const c=candidates.get(m.matchId),h=heroById.get(m.matchId);assert(c&&c.isPro===true&&m.isPro===true,'pro_boundary');
  assert.equal(c.outcome.status,'verified');assert.equal(c.startedAtUs,m.startedAtUs);assert.equal(c.endedAtUs,m.completedAtUs);
  assert(BigInt(m.startedAtUs)<BigInt(m.completedAtUs));
  if(!h){excluded.push({matchId:m.matchId,reason:'HERO_ROW_MISSING'});continue;}
  assert.equal(h.dataRevision,c.dataRevision,'revision_binding');assert.equal(h.receiptId,m.outcomeReceiptId,'receipt_binding');
  assert.equal(h.sourceSha256,m.payloadSha256,'source_binding');
  const players=[...h.players].sort((a,b)=>a.player_slot-b.player_slot),receipt=[...(h.receiptPlayers??[])].sort((a,b)=>a.player_slot-b.player_slot);
  const identities=[...m.teamA,...m.teamB];
  if(players.length!==10||receipt.length!==10||new Set(players.map(p=>p.hero_id)).size!==10||players.some((p,i)=>
   p.player_slot!==slots[i]||receipt[i]?.player_slot!==p.player_slot||!Number.isInteger(p.hero_id)||p.hero_id<=0||receipt[i]?.hero_id!==p.hero_id)){
   excluded.push({matchId:m.matchId,reason:'FINAL_HERO_RECEIPT_INVALID'});continue;
  }
  assert.equal(new Set(identities.map(key)).size,10,'duplicate_identity');
  assert.equal(new Set(identities.map(p=>p.playerId)).size,10,'duplicate_player');
  assert.equal(new Set(identities.map(p=>p.accountId)).size,10,'duplicate_account');
  if(players.some(p=>p.player_id===null)){
   excluded.push({matchId:m.matchId,reason:'CANONICAL_HERO_IDENTITY_UNRESOLVED'});continue;
  }
  for(let i=0;i<10;i++){
   assert.equal(players[i].player_id,identities[i].playerId,'canonical_identity');
   assert.equal(String(receipt[i].account_id),identities[i].accountId,'receipt_account');
   assert.equal(c.players.find(p=>p.playerSlot===slots[i])?.sourceAccountId,identities[i].accountId,'canonical_account');
  }
  const patch=patches.get(m.matchId);
  if(patch){assert.equal(patch.sourceSha256,h.sourceSha256,'patch_source');assert.equal(patch.dataRevision,c.dataRevision);}
  maps.push({matchId:m.matchId,seriesKey:m.seriesKey,startedAtUs:m.startedAtUs,completedAtUs:m.completedAtUs,
   fetchedAtUs:m.fetchedAtUs,canonicalPatchId:patch?.canonicalPatchId??null,providerPatchId:patch?.providerPatchId??null,
   players:players.map((p,i)=>({...identities[i],slot:p.player_slot,heroId:p.hero_id}))});
 }
 return {maps:maps.sort((a,b)=>numeric(a.matchId,b.matchId)),excluded:excluded.sort((a,b)=>numeric(a.matchId,b.matchId))};
}

const distribution=values=>({n:values.length,min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null,
 median:values.length?[...values].sort((a,b)=>a-b).slice(Math.floor((values.length-1)/2),Math.floor(values.length/2)+1).reduce((a,b)=>a+b,0)/(values.length%2?1:2):null,
 zero:values.filter(v=>v===0).length,oneToTwo:values.filter(v=>v>=1&&v<=2).length,threeToFour:values.filter(v=>v>=3&&v<=4).length,
 fiveToNine:values.filter(v=>v>=5&&v<=9).length,tenPlus:values.filter(v=>v>=10).length});

/** No outcomes, ratings or fitted predictions are read. Full target ledger is retained. */
export function auditPlayerHeroCoverage(dataset,history,bound){
 const targets=index(dataset.rows),all=index(history.maps),valid=index(bound.maps),byPlayer=new Map();
 for(const m of history.maps)for(const p of [...m.teamA,...m.teamB]){
  const entries=byPlayer.get(key(p))??[];entries.push(m);byPlayer.set(key(p),entries);
 }
 const rows=[...targets.values()].sort((a,b)=>numeric(a.matchId,b.matchId)).map(t=>{
  const base={matchId:t.matchId,nominalWindow:t.nominalWindow,seriesKey:t.seriesKey,pairedEligible:t.pairedEligible,
   originalReasons:t.reasons,status:'not_assessed_originally_ineligible',players:null};
  if(!t.pairedEligible)return base;
  const target=valid.get(t.matchId);assert(target&&all.has(t.matchId),'target_hero_missing');
  assert.equal(target.seriesKey,historySeriesKey(t.seriesKey),'target_series');assert.equal(target.startedAtUs,t.featureSnapshot.cutoffAtUs,'target_cutoff');
  const cutoff=BigInt(target.startedAtUs),recentFrom=cutoff-BigInt(AUDIT_POLICY.recentDays)*86400000000n;
  const players=target.players.map(p=>{
   const prior=(byPlayer.get(key(p))??[]).filter(m=>m.matchId!==t.matchId&&BigInt(m.startedAtUs)<cutoff&&BigInt(m.completedAtUs)<cutoff);
   const known=prior.flatMap(m=>{const h=valid.get(m.matchId);if(!h)return [];const member=h.players.find(x=>key(x)===key(p));assert(member);return [{...h,member}];});
   const same=known.filter(m=>m.member.heroId===p.heroId).sort((a,b)=>numeric(a.matchId,b.matchId));
   const ids=same.map(m=>m.matchId),recent=same.filter(m=>BigInt(m.startedAtUs)>=recentFrom);
   return {...p,priorProMaps:prior.length,priorHeroKnownMaps:known.length,priorHeroUnknownMaps:prior.length-known.length,
    nRaw:same.length,priorMatchIds:ids,nRecent90Days:recent.length,recentMatchIds:recent.map(m=>m.matchId),
    sameProviderPatch:target.providerPatchId===null?null:same.filter(m=>m.providerPatchId!==null&&m.providerPatchId===target.providerPatchId).length,
    priorProviderPatchUnknown:same.filter(m=>m.providerPatchId===null).length,
    sameCanonicalPatch:target.canonicalPatchId===null?null:same.filter(m=>m.canonicalPatchId!==null&&m.canonicalPatchId===target.canonicalPatchId).length,
    priorCanonicalPatchUnknown:same.filter(m=>m.canonicalPatchId===null).length,
    sourceFetchedBeforeTarget:same.filter(m=>m.fetchedAtUs!==null&&BigInt(m.fetchedAtUs)<cutoff).length,
    knownAsOfHistory:null,roleConditionedHistory:null,
    lastPlayedAt:same.length?new Date(Number(same.reduce((a,m)=>BigInt(m.startedAtUs)>a?BigInt(m.startedAtUs):a,0n)/1000n)).toISOString():null};
  });
  return {...base,status:'assessed_conditional_coverage',cutoffAtUs:target.startedAtUs,providerPatchId:target.providerPatchId,
   canonicalPatchId:target.canonicalPatchId,players};
 });
 const partitions=Object.fromEntries(Object.entries(dataset.partitions).map(([name,definition])=>{
  const ledger=rows.filter(r=>r.nominalWindow===name),selected=ledger.filter(r=>r.players!==null),players=selected.flatMap(r=>r.players);
  assert.equal(ledger.length,definition.plannedDenominator,'denominator_drift');
  return [name,{plannedMaps:ledger.length,assessedMaps:selected.length,assessedSeries:new Set(selected.map(r=>r.seriesKey)).size,
   playerTargetSlots:players.length,localAllHistory:distribution(players.map(p=>p.nRaw)),recent90Days:distribution(players.map(p=>p.nRecent90Days)),
   thresholds:AUDIT_POLICY.thresholds.map(n=>({n,slotsAtLeast:players.filter(p=>p.nRaw>=n).length,
    allTenMaps:selected.filter(r=>r.players.every(p=>p.nRaw>=n)).length,
    allTenRecentMaps:selected.filter(r=>r.players.every(p=>p.nRecent90Days>=n)).length})),
   providerPatchTargets:selected.filter(r=>r.providerPatchId!==null).length,canonicalPatchTargets:selected.filter(r=>r.canonicalPatchId!==null).length,
   sameProviderPatch:distribution(players.flatMap(p=>p.sameProviderPatch===null?[]:[p.sameProviderPatch])),
   slotsWithIncompleteHeroHistory:players.filter(p=>p.priorHeroUnknownMaps>0).length,
   sourceFetchedBeforeTargetContributions:players.reduce((n,p)=>n+p.sourceFetchedBeforeTarget,0)}];
 }));
 return {format:'post-draft-player-hero-audit-v1',policy:AUDIT_POLICY,syntheticOnly:history.syntheticOnly,
  history:{verifiedProMaps:history.maps.length,heroBoundMaps:bound.maps.length,excluded:bound.excluded,
   providerPatchMaps:bound.maps.filter(m=>m.providerPatchId!==null).length,canonicalPatchMaps:bound.maps.filter(m=>m.canonicalPatchId!==null).length},
  partitions,rows,limitations:['LOCAL_HISTORY_NOT_EXHAUSTIVE','ZERO_LOCAL_COUNT_NOT_ZERO_EXPERIENCE','TARGET_HERO_RECONSTRUCTED',
   'HISTORICAL_KNOWN_AT_NOT_ESTABLISHED','ROLE_NOT_CAPTURED','PROVIDER_PATCH_NOT_CANONICAL','NO_WEIGHTING_OR_HERO_TRANSFER_POLICY','NO_INDEPENDENT_TEST'],
  trainingPerformed:false,scoringPerformed:false,activationAllowed:false,deployable:false};
}

export async function preparePlayerHeroAudit(){
 const dataset=await boundedJson(join(root,'.tools/s304-r2-dataset-r1.json')),
  evidence=await boundedJson(join(root,'docs/evidence/s3-04-r2-frozen-dataset.json'));
 assert.equal(dataset.sha256,evidence.value.datasetSha256);
 const refs={capture:['.tools/s304-dataset-capture-final.json','baselineCaptureSha256'],source:['.tools/s304-history-coverage-source-r1.json','historyCaptureSha256'],
  importPlan:['.tools/s304-history-import-plan.json','importPlanSha256'],protocol:['docs/evidence/s3-04-conditional-protocol.json','protocolSha256']};
 const loaded={};for(const [k,[path,hashKey]]of Object.entries(refs)){loaded[k]=await boundedJson(join(root,path));assert.equal(loaded[k].sha256,dataset.value.inputs[hashKey],k+'_sha');}
 const inventory=await boundedJson(join(root,'.tools/s304-final.json'));assert.equal(inventory.sha256,loaded.protocol.value.inputs.inventorySha256);
 for(const entry of dataset.value.code)assert.equal(sha(await readFile(join(root,entry.path))),entry.sha256,'inherited_code_changed');
 const {fingerprint,...body}=dataset.value;assert.equal(digest(body),fingerprint);
 const source=loaded.source.value.source;assert.equal(source.syntheticOnly,false,'synthetic_cli_forbidden');
 const history=prepareV1PerMapFeatureHistory(source);assert.equal(history.sourceFingerprint,dataset.value.history.fingerprint);
 const heroes=structuredClone(loaded.capture.value.heroes),candidates=index(source.candidates);
 for(const id of dataset.value.targetLedger.addedHistoryOnlyIds){
  const m=loaded.importPlan.value.plan.maps.find(m=>m.matchId===id),c=candidates.get(id);assert(m&&!m.reasons.length&&c);
  heroes.push({matchId:id,dataRevision:c.dataRevision,receiptId:c.outcome.outcomeReceiptId,sourceSha256:m.projectionSha256,
   players:m.members.map(p=>({player_slot:p.slot,hero_id:p.heroId,player_id:p.playerId})),
   receiptPlayers:m.members.map(p=>({player_slot:p.slot,hero_id:p.heroId,account_id:Number(p.accountId)}))});
 }
 const bound=bindHeroHistory(history,source,heroes,inventory.value.maps),result=auditPlayerHeroCoverage(dataset.value,history,bound);
 const code={};for(const path of ['tools/research/post-draft-player-hero-audit.mjs','tests/node/post-draft-player-hero-audit.test.mjs'])code[path]=sha(await readFile(join(root,path)));
 const artifact={...result,sourceHashes:{dataset:dataset.sha256,datasetEvidence:evidence.sha256,inventory:inventory.sha256,
  ...Object.fromEntries(Object.entries(loaded).map(([k,v])=>[k,v.sha256]))},code};
 return {...artifact,fingerprint:digest(artifact)};
}
async function main(){
 const [mode,path,...extra]=process.argv.slice(2);assert(['create','verify'].includes(mode)&&path&&!extra.length);
 const output=resolve(root,path),rel=relative(join(root,'.tools'),output);assert(rel&&!rel.startsWith('..')&&!rel.includes(':'));
 const result=await preparePlayerHeroAudit();
 if(mode==='create')await writeFile(output,JSON.stringify(result)+'\n',{flag:'wx'});
 else assert.equal(digest((await boundedJson(output)).value),digest(result),'audit_replay');
 console.log(JSON.stringify({status:mode==='create'?'created_coverage_only':'verified_coverage_only',fingerprint:result.fingerprint,
  history:result.history,partitions:result.partitions,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{
 console.error(e.code==='EEXIST'?'Аудит уже существует; используйте отдельную версию.':'Аудит отклонён: проверьте SHA, составы, героев и временные границы.');process.exitCode=1;
});
