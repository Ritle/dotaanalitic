import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareV1PerMapFeatureHistory} from '../../packages/db/dist/index.js';
import {boundedJson,CaptureSchema,buildPostDraftDataset,datasetCode,digest,sha} from './post-draft-dataset.mjs';
import {buildPostDraftPlan} from './post-draft-plan.mjs';
import {buildR2Plan} from './post-draft-r2-plan.mjs';
const slots=[0,1,2,3,4,128,129,130,131,132];
const numeric=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const ids=rows=>rows.map(r=>r.matchId).sort(numeric);
const index=rows=>{const m=new Map(rows.map(r=>[r.matchId,r]));assert.equal(m.size,rows.length,'duplicate_map');return m;};
const us=t=>(BigInt(Date.parse(t))*1000n).toString();
const semanticMap=m=>{const c=structuredClone(m);if(c.outcome.status==='verified')delete c.outcome.labelVerifiedAt;return c;};
export function assertCodeCompatibility(original,current){
 const paths=new Map(current.map(x=>[x.path,x]));assert.equal(paths.size,current.length,'duplicate_code_path');
 for(const entry of original)assert.deepEqual(paths.get(entry.path),entry,'R1_executable_or_migration_changed');
 const added=current.filter(x=>!original.some(o=>o.path===x.path));
 const allowed=['packages/db/migrations/055_live_schedule.sql','packages/db/migrations/056_live_lineup_estimates.sql','packages/db/migrations/057_history_projection_import_audit.sql'];
 assert(added.every(x=>allowed.includes(x.path)),'unapproved_executable_addition');
 return {originalFilesPreserved:original.length,additiveMigrations:added};
}
/** Only acquisition/verification revision fields may differ in train/validation provenance. */
export function semanticRow(row){
 const copy=structuredClone(row),elo=copy.featureSnapshot?.elo;
 if(elo){delete elo.fingerprint;delete elo.scenario.lineup.revision;
  for(const k of ['sourceFingerprint','identityRevision','snapshotAtUs'])delete elo.history[k];}
 return copy;
}
export function assertEarlyParity(baseline,result){
 const summary={};
 for(const partition of ['train','validation']){
  const old=baseline.rows.filter(r=>r.nominalWindow===partition),current=result.rows.filter(r=>r.nominalWindow===partition);
  assert.deepEqual(current.map(semanticRow),old.map(semanticRow),'early_features_or_eligibility_drift');
  const selected=new Set(ids(old)),oldLabels=baseline.labels.filter(l=>selected.has(l.matchId)),newLabels=result.labels.filter(l=>selected.has(l.matchId));
  assert.deepEqual(newLabels,oldLabels,'early_label_drift');
  assert.deepEqual(result.partitions[partition],baseline.partitions[partition],'early_partition_drift');
  summary[partition]={targetRows:old.length,pairedMaps:current.filter(r=>r.pairedEligible).length,
   semanticRowsSha256:digest(current.map(semanticRow)),labelsSha256:digest(newLabels),status:'exact_except_declared_snapshot_provenance'};
 }
 assert.deepEqual(result.heroVocabulary,baseline.heroVocabulary,'vocabulary_drift');
 return summary;
}

/** The R1 builder remains unchanged; history-only siblings enter its inventory but never its target denominator. */
export function buildR2Dataset({protocol,baselineCapture,baselineDataset,currentSource,metadata,importPlan,importReport,r2Plan}){
 const original=CaptureSchema.parse(baselineCapture),old=index(original.source.candidates),current=index(currentSource.candidates);
 const targetIds=new Set(r2Plan.targetLedger.mapIds),addedIds=r2Plan.targetLedger.newHistoryIds;
 assert.equal(targetIds.size,r2Plan.targetLedger.count);assert.equal(new Set(addedIds).size,addedIds.length);
 assert.deepEqual([...targetIds].sort(numeric),ids(original.source.candidates));
 assert.deepEqual([...addedIds].sort(numeric),ids(importReport.base));assert.equal(current.size,old.size+addedIds.length);
 assert.equal(currentSource.syntheticOnly,original.source.syntheticOnly);
 assert.deepEqual(currentSource.identities,original.source.identities,'identity_evidence_drift');
 const codeCompatibility=assertCodeCompatibility(original.source.code,currentSource.code);
 for(const a of original.source.aliases)assert.deepEqual(currentSource.aliases.find(b=>a.seriesId===b.seriesId),a,'series_alias_drift');
 for(const [id,m] of old)assert.deepEqual(semanticMap(current.get(id)),semanticMap(m),'original_map_fact_drift');
 const meta=index(metadata),prepared=prepareV1PerMapFeatureHistory(currentSource),history=index(prepared.maps);
 // R1 lineup hashes bind the original JSON representation, including SQL object-key order.
 const heroes=structuredClone(baselineCapture.heroes),addedInventory=[];
 for(const id of addedIds){
  assert(!old.has(id));const m=current.get(id),p=importPlan.maps.find(m=>m.matchId===id),h=history.get(id),md=meta.get(id),outcome=importReport.outcomes.find(m=>m.matchId===id);
  assert(m&&p&&!p.reasons.length&&h&&md&&outcome?.status==='verified','addition_not_verified');
  assert(md.startedAt>=protocol.policy.windows.find(w=>w.name==='validation').until,'addition_changes_fitting_period');
  assert.equal(m.startedAtUs,us(md.startedAt));assert.equal(m.endedAtUs,us(md.completedAt));assert.equal(m.dataRevision,md.dataRevision);
  assert.equal(md.sourceSeriesId,p.sourceSeriesId);assert.equal(md.seriesProvider,'opendota');assert.equal(md.seriesId,m.seriesId);
  for(const k of ['outcomeReceiptId','teamAId','teamBId','teamAWon','startedAt','completedAt','dataRevision'])assert.deepEqual(m.outcome[k],outcome[k],'import_outcome_drift');
  assert.equal(m.outcome.sourceEvidence.payloadSha256,p.projectionSha256);
  const members=[...p.members].sort((a,b)=>a.slot-b.slot);
  assert.deepEqual(members.map(p=>p.slot),slots);assert.equal(new Set(members.map(p=>p.heroId)).size,10);
  assert(members.every(p=>Number.isInteger(p.heroId)&&p.heroId>0&&BigInt(p.accountId)>0n&&BigInt(p.accountId)<4294967295n));
  assert.deepEqual([...h.teamA,...h.teamB].map(p=>[p.playerId,p.accountId]),members.map(p=>[p.playerId,p.accountId]));
  const players=members.map(p=>({player_slot:p.slot,hero_id:p.heroId,player_id:p.playerId}));
  heroes.push({matchId:id,dataRevision:m.dataRevision,players,receiptId:m.outcome.outcomeReceiptId,sourceSha256:p.projectionSha256,
   receiptPlayers:members.map(p=>({player_slot:p.slot,hero_id:p.heroId,account_id:Number(p.accountId)}))});
  addedInventory.push({matchId:id,startedAt:md.startedAt,dataRevision:md.dataRevision,lineupSha256:sha(JSON.stringify(players)),sourceSha256:p.projectionSha256,researchInventoryCandidate:true});
  const group=importPlan.groups.find(g=>g.sourceSeriesId===p.sourceSeriesId);assert(group&&!group.reasons.length,'import_series_review');
  for(const sibling of group.knownMapIds){const s=meta.get(sibling);assert(s&&s.seriesProvider==='opendota'&&s.sourceSeriesId===p.sourceSeriesId,'missing_known_sibling');}
 }
 const inventoryBody={policyVersion:'post-draft-readiness-inventory-v1',trainingReady:false,deployable:false,
  maps:[...protocol.dispositions.map(d=>({matchId:d.matchId,startedAt:d.startedAt,dataRevision:d.dataRevision,lineupSha256:d.inventoryLineupSha256,
   sourceSha256:d.sourceSha256,researchInventoryCandidate:!d.reasons.includes('INVENTORY_INELIGIBLE')})),...addedInventory]};
 const inventory={...inventoryBody,fingerprint:sha(JSON.stringify(inventoryBody))};
 const expanded=buildPostDraftPlan(inventory,metadata,protocol.policy),fresh=index(expanded.dispositions),changes=[];
 const dispositions=protocol.dispositions.map(d=>{
  const f=fresh.get(d.matchId);assert.equal(f.seriesKey,d.seriesKey);assert.equal(f.nominalWindow,d.nominalWindow);
  const reasons=[...new Set([...d.reasons,...f.reasons])].sort();
  const result={...d,reasons,partition:d.partition&&f.partition?d.partition:null};
  if(digest(result)!==digest(d))changes.push({matchId:d.matchId,reasons,partition:result.partition});
  return result;
 });
 // No minimum-history requirement for history-only rows themselves. Their verified map/series bindings were checked above.
 for(const id of addedIds)dispositions.push({...fresh.get(id),partition:null,nominalWindow:null,reasons:[...fresh.get(id).reasons,'R2_HISTORY_ONLY']});
 const {fingerprint:r1Fingerprint,...referenceProtocol}=protocol;
 const internalBody={...referenceProtocol,dispositions,metadataScope:'R2_internal_all_known_siblings_original_targets_only',
  derivedFromR1Fingerprint:r1Fingerprint,r2PlanFingerprint:r2Plan.fingerprint};
 const internalProtocol={...internalBody,fingerprint:digest(internalBody)};
 const expandedCapture={...original,protocolFingerprint:internalProtocol.fingerprint,source:currentSource,heroes};
 const built=buildPostDraftDataset(internalProtocol,expandedCapture);
 built.rows=built.rows.filter(r=>targetIds.has(r.matchId));built.labels=built.labels.filter(l=>targetIds.has(l.matchId));
 // Preserve the original receipt label and verification timestamp; the fresh verification remains separately auditable.
 const reverifications=built.labels.map(label=>{
  const o=old.get(label.matchId).outcome;assert.equal(o.status,'verified');
  const aRadiant=BigInt(o.teamAId)<BigInt(o.teamBId);
  const originalLabel={matchId:label.matchId,teamAWon:aRadiant?o.teamAWon:!o.teamAWon,completedAt:o.completedAt,verifiedAt:o.labelVerifiedAt,receiptId:o.outcomeReceiptId,sourceEvidence:o.sourceEvidence};
  assert.deepEqual({...label,verifiedAt:o.labelVerifiedAt},originalLabel,'target_label_changed');
  return {matchId:label.matchId,originalVerifiedAt:o.labelVerifiedAt,reverifiedAt:label.verifiedAt,receiptId:label.receiptId};
 });
 built.labels=built.labels.map(label=>({...label,verifiedAt:old.get(label.matchId).outcome.labelVerifiedAt}));
 const parity=assertEarlyParity(baselineDataset,built),before=index(baselineDataset.rows);
 const comparison={};
 for(const partition of ['calibration','development_test']){
  const rows=built.rows.filter(r=>r.nominalWindow===partition),common=rows.filter(r=>r.pairedEligible&&before.get(r.matchId).pairedEligible);
  comparison[partition]={commonIds:ids(common),recoveredIds:ids(rows.filter(r=>r.pairedEligible&&!before.get(r.matchId).pairedEligible)),
   lostIds:ids(rows.filter(r=>!r.pairedEligible&&before.get(r.matchId).pairedEligible)),
   commonChangedInputs:common.filter(r=>digest(r.inputs)!==digest(before.get(r.matchId).inputs)).length};
 }
 return {...built,format:'conditional-post-draft-r2-dataset-v1',protocolFingerprint:r2Plan.fingerprint,r1ProtocolFingerprint:protocol.fingerprint,
  derivedInventoryProtocolFingerprint:internalProtocol.fingerprint,
  r2Plan:{fingerprint:r2Plan.fingerprint,parameters:r2Plan.parameters,evaluation:r2Plan.evaluation},
  targetLedger:{count:targetIds.size,addedHistoryOnlyIds:[...addedIds].sort(numeric),seriesDispositionChanges:changes,
   knownSeriesMembershipChecked:true,remoteSeriesCompleteness:'unknown_not_inferred'},
  labelReverifications:reverifications,earlyParity:parity,comparison,codeCompatibility,
  audit:{providerHttp:0,businessWrites:0,coefficientFitting:false,calibrationFitting:false,targetScoring:false,independentTest:false},
  provenanceDifferencesAllowed:['elo.fingerprint','elo.scenario.lineup.revision','elo.history.sourceFingerprint','elo.history.identityRevision','elo.history.snapshotAtUs']};
}

const planPath='docs/evidence/s3-04-r2-protocol.json';
const canonicalPlan=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export async function prepareR2Dataset(){
 const plan=await boundedJson(planPath),{fingerprint,...body}=plan.value;assert.equal(sha(canonicalPlan(body)),fingerprint);
 const all={...plan.value.inputs,...plan.value.frozenFiles},loaded={};
 for(const [k,ref] of Object.entries(all)){loaded[k]=await boundedJson(ref.path);assert.equal(loaded[k].sha256,ref.sha256,'R2_input_hash');}
 for(const [p,hash] of Object.entries(plan.value.code))assert.equal(sha(await readFile(p)),hash,'R2_plan_code_hash');
 const r=loaded,expected=buildR2Plan({protocol:r.protocol.value,baselineMetadata:r.baselineMetadata.value,metadata:r.metadata.value,
  addedIds:r.importReport.value.base.map(m=>m.matchId),coverage:r.coverage.value,plannedAt:plan.value.plannedAt});
 for(const [k,v] of Object.entries(expected))assert.deepEqual(plan.value[k],v,'R2_plan_replay');
 const baseline=await boundedJson('.tools/s304-dataset-capture-final.json'),ip=await boundedJson('.tools/s304-history-import-plan.json');
 assert.equal(baseline.sha256,r.r1Dataset.value.inputs.captureSha256);assert.equal(ip.sha256,r.coverage.value.inputs.plan);
 const code=await datasetCode();assertCodeCompatibility(baseline.value.source.code,code);assert.deepEqual(code,r.historyCapture.value.source.code);
 const {fingerprint:oldFingerprint,...oldBody}=r.r1Dataset.value;assert.equal(digest(oldBody),oldFingerprint);
 assert(!baseline.value.source.syntheticOnly&&!r.historyCapture.value.source.syntheticOnly,'synthetic_cli_forbidden');
 const result=buildR2Dataset({protocol:r.protocol.value,baselineCapture:baseline.value,baselineDataset:r.r1Dataset.value,currentSource:r.historyCapture.value.source,
  metadata:r.metadata.value,importPlan:ip.value.plan,importReport:r.importReport.value,r2Plan:plan.value});
 const implementation={};for(const p of ['tools/research/post-draft-r2-dataset.mjs','tests/node/post-draft-r2-dataset.test.mjs'])implementation[p]=sha(await readFile(p));
 const artifact={...result,inputs:{r2PlanSha256:plan.sha256,baselineCaptureSha256:baseline.sha256,importPlanSha256:ip.sha256,
  ...Object.fromEntries(Object.entries(loaded).map(([k,v])=>[k+'Sha256',v.sha256]))},code,implementation};
 return {...artifact,fingerprint:digest(artifact)};
}
async function main(){
 const [mode,output,...extra]=process.argv.slice(2);assert(['create','verify'].includes(mode)&&output&&!extra.length);
 const result=await prepareR2Dataset();
 if(mode==='create'){const bytes=JSON.stringify(result)+'\n';assert(Buffer.byteLength(bytes)<=128*1024*1024);await writeFile(output,bytes,{flag:'wx'});}
 else assert.equal(digest((await boundedJson(output)).value),digest(result),'R2_dataset_replay');
 console.log(JSON.stringify({status:mode==='create'?'frozen_research_only':'verified_research_only',fingerprint:result.fingerprint,
  partitions:result.partitions,earlyParity:result.earlyParity,comparison:result.comparison,historyMaps:result.history.eligibleMaps,
  dataChecks:result.dataChecks,seriesChanges:result.targetLedger.seriesDispositionChanges,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{
 console.error(e.code==='EEXIST'?'Выборка R2 уже существует; нужна новая версия.':'Выборка R2 отклонена: проверьте SHA, неизменность R1, идентичности и серии.');process.exitCode=1;
});
