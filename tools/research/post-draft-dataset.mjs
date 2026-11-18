import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,readdir,stat} from 'node:fs/promises';
import {V1DataSourceSchema} from '../../packages/contracts/dist/index.js';
import {prepareV1MapHistory,prepareV1PerMapFeatureHistory,canonicalContextJson} from '../../packages/db/dist/index.js';
import {createV1FeatureBuilder,V1_FEATURE_POLICY} from '../../packages/prediction/dist/index.js';
import {preparePlan} from './post-draft-plan.mjs';
const {z}=createRequire(new URL('../../packages/contracts/package.json',import.meta.url))('zod');
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const digest=value=>sha(canonicalContextJson(value));
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(x=>BigInt(x)<=9223372036854775807n);
const Sha=z.string().regex(/^[a-f0-9]{64}$/);
const CanonicalPlayer=z.object({player_slot:z.number().int(),hero_id:z.number().int().positive().nullable(),player_id:Id.nullable()}).strict();
const ReceiptPlayer=z.object({player_slot:z.number().int(),hero_id:z.number().int().nonnegative().nullable(),account_id:z.number().int().nonnegative().nullable()}).strict();
const HeroRow=z.object({matchId:Id,dataRevision:z.string().regex(/^\d+$/),players:z.array(CanonicalPlayer).max(100),
 receiptId:Id.nullable(),sourceSha256:Sha.nullable(),receiptPlayers:z.array(ReceiptPlayer).max(100).nullable()}).strict();
export const CaptureSchema=z.object({format:z.literal('post-draft-capture-v1'),protocolFingerprint:Sha,
 source:V1DataSourceSchema,heroes:z.array(HeroRow).max(5000)}).strict();
const us=x=>(BigInt(Date.parse(x))*1000n).toString();
const cmp=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const slots=[0,1,2,3,4,128,129,130,131,132];
const unique=(rows,key)=>{const m=new Map(rows.map(r=>[r[key],r]));if(m.size!==rows.length)throw Error('duplicate_'+key);return m;};
export async function boundedJson(path,max=128*1024*1024){
 if((await stat(path)).size>max)throw Error('file_limit');const bytes=await readFile(path);if(bytes.length>max)throw Error('file_limit');
 return {bytes,value:JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')),sha256:sha(bytes)};
}
export async function verifiedProtocol(inventoryPath,metadataPath,protocolPath){
 const {value:protocol,sha256}=await boundedJson(protocolPath,16*1024*1024);
 const {fingerprint,registeredAt,...body}=protocol;
 if(sha(JSON.stringify({registeredAt,...body}))!==fingerprint||digest(body)!==digest(await preparePlan(inventoryPath,metadataPath))||
  !Number.isFinite(Date.parse(registeredAt))||registeredAt>new Date().toISOString()||registeredAt<body.policy.windows.at(-1).until)throw Error('protocol_mismatch');
 return {protocol,sha256};
}
/** Bind actual executable JS, SQL and dependencies, outside the active model's frozen scripts tree. */
export async function datasetCode(){
 const paths=['tools/research/post-draft-dataset.mjs','tools/research/capture-post-draft.mjs','tools/research/freeze-post-draft.mjs','package.json','pnpm-lock.yaml'];
 for(const directory of ['packages/contracts/dist','packages/db/dist','packages/prediction/dist','packages/db/migrations']){
  for(const name of (await readdir(new URL('../../'+directory+'/',import.meta.url))).sort())if(/\.(js|sql)$/.test(name))paths.push(directory+'/'+name);
 }
 return Promise.all(paths.sort().map(async path=>({path,sha256:sha(await readFile(new URL('../../'+path,import.meta.url)))})));
}

/** Research only. Targets and independent history share the existing verified V1 boundary. */
export function buildPostDraftDataset(protocol,captureInput){
 const capture=CaptureSchema.parse(captureInput),source=capture.source,policy=protocol.policy;
 if(capture.protocolFingerprint!==protocol.fingerprint||protocol.deployable!==false||policy.deployable!==false||
  policy.release.activationAllowed!==false)throw Error('research_protocol_binding');
 if(source.request.fromAt!==policy.history.warmupFrom||source.request.toAt!==policy.windows.at(-1).until||
  source.request.snapshotAt<protocol.registeredAt)throw Error('history_window');
 for(const k of ['initialRating','k','scale','minCompletedProMapsPerPlayer'])if(policy.history[k]!==V1_FEATURE_POLICY[k])throw Error('elo_policy_changed');
 const candidates=unique(source.candidates,'matchId'),heroes=unique(capture.heroes,'matchId'),ledger=unique(protocol.dispositions,'matchId');
 const pro=source.candidates.filter(m=>m.isPro===true);
 if(pro.length!==ledger.size||heroes.size!==ledger.size||pro.some(m=>!ledger.has(m.matchId)))throw Error('inventory_changed');
 const prepared=prepareV1MapHistory(source),history=prepareV1PerMapFeatureHistory(source),builder=createV1FeatureBuilder(history);
 const historyMaps=unique(history.maps,'matchId'),assessments=unique(prepared.report.assessments,'matchId'),aliases=unique(source.aliases,'seriesId');
 const rows=protocol.dispositions.map(d=>{
  const m=candidates.get(d.matchId),h=heroes.get(d.matchId);
  if(!m||!h||m.dataRevision!==d.dataRevision||h.dataRevision!==d.dataRevision||m.startedAtUs!==us(d.startedAt)||m.endedAtUs!==us(d.completedAt))throw Error('stale_map');
  const canonical=[...h.players].sort((a,b)=>a.player_slot-b.player_slot);
  const originalPlayers=captureInput.heroes.find(r=>r.matchId===d.matchId).players;
  if(sha(JSON.stringify([...originalPlayers].sort((a,b)=>a.player_slot-b.player_slot)))!==d.inventoryLineupSha256)throw Error('stale_lineup');
  const alias=aliases.get(m.seriesId),key=alias?.provider==='opendota'&&/^[1-9]\d*$/.test(alias.providerSeriesId??'')?JSON.stringify(['opendota',alias.providerSeriesId]):null;
  if(key!==d.seriesKey)throw Error('stale_series');
  const reasons=[...d.reasons];
  const base={matchId:d.matchId,seriesKey:d.seriesKey,partition:d.partition,nominalWindow:d.nominalWindow,reasons,baselineEligible:false,pairedEligible:false,inputs:null,featureSnapshot:null,label:null};
  if(!d.partition)return base;
  reasons.push(...assessments.get(d.matchId).reasons);
  const hm=historyMaps.get(d.matchId);
  if(!hm)return base;
  const o=m.outcome;
  if(o.status!=='verified')throw Error('verified_history_without_outcome');
  if(h.receiptId!==o.outcomeReceiptId||h.sourceSha256!==o.sourceEvidence.payloadSha256||h.sourceSha256!==d.sourceSha256)throw Error('receipt_binding_changed');
  const rp=[...(h.receiptPlayers??[])].sort((a,b)=>a.player_slot-b.player_slot);
  if(canonical.length!==10||rp.length!==10||new Set(canonical.map(p=>p.hero_id)).size!==10||canonical.some((p,i)=>p.player_slot!==slots[i]||p.hero_id===null||
   rp[i]?.player_slot!==p.player_slot||rp[i]?.hero_id!==p.hero_id||String(rp[i]?.account_id)!==m.players.find(x=>x.playerSlot===p.player_slot)?.sourceAccountId))reasons.push('FINAL_HERO_RECEIPT_INVALID');
  if(canonical.some(p=>p.player_id!==[...hm.teamA,...hm.teamB][slots.indexOf(p.player_slot)]?.playerId))reasons.push('CANONICAL_IDENTITY_MISMATCH');
  if(reasons.length)return base;
  const aRadiant=BigInt(o.teamAId)<BigInt(o.teamBId),teamA=aRadiant?hm.teamA:hm.teamB,teamB=aRadiant?hm.teamB:hm.teamA;
  const scenario={schemaVersion:1,cutoffAtUs:m.startedAtUs,targetMatchId:m.matchId,teamA,teamB,
   lineup:{basis:'actual_lineup_reconstructed',source:'verified-map-receipt:'+o.outcomeReceiptId,selectedAtUs:hm.fetchedAtUs,revision:history.sourceFingerprint}};
  const result=builder(scenario);reasons.push(...result.reasons);
  if(result.status!=='ready')return base;
  // Native slots bind heroes to map sides; canonical organization ID only chooses orientation.
  const signedHeroes=canonical.map(p=>({heroId:p.hero_id,value:(p.player_slot<128)===aRadiant?1:-1})).sort((a,b)=>a.heroId-b.heroId);
  const inputs={eloLogit:Math.log(10)*result.features.eloDifference/policy.history.scale,signedHeroes};
  for(const id of result.history.usedMatchIds){const prior=historyMaps.get(id);if(!prior||id===m.matchId||BigInt(prior.startedAtUs)>=BigInt(m.startedAtUs)||BigInt(prior.completedAtUs)>=BigInt(m.startedAtUs))throw Error('future_history');}
  return {...base,baselineEligible:true,inputs,featureSnapshot:{featureSchemaVersion:'conditional-elo-signed-heroes-v1',inputSha256:digest(inputs),
   teamAId:aRadiant?o.teamAId:o.teamBId,teamBId:aRadiant?o.teamBId:o.teamAId,teamASide:aRadiant?'radiant':'dire',
   cutoffAtUs:m.startedAtUs,elo:result,heroesBasis:'reconstructed_final_receipt',sourceSha256:h.sourceSha256,inventoryLineupSha256:d.inventoryLineupSha256},
   label:{teamAWon:aRadiant?o.teamAWon:!o.teamAWon,completedAt:o.completedAt,verifiedAt:o.labelVerifiedAt,receiptId:o.outcomeReceiptId,sourceEvidence:o.sourceEvidence}};
 });
 // Keep every known sibling of a final eligible target series; target rejection never shrinks history.
 const badSeries=new Set(rows.filter(r=>r.partition&&!r.baselineEligible).map(r=>r.seriesKey));
 for(const row of rows)if(row.partition&&badSeries.has(row.seriesKey)){
  row.reasons.push('SERIES_HAS_INELIGIBLE_DATASET_MAP');row.baselineEligible=false;
 }
 const vocabulary=[...new Set(rows.filter(r=>r.partition==='train'&&r.baselineEligible).flatMap(r=>r.inputs.signedHeroes.map(h=>h.heroId)))].sort((a,b)=>a-b);
 const vocab=new Set(vocabulary);
 for(const row of rows){
  if(row.baselineEligible){if(row.inputs.signedHeroes.some(h=>!vocab.has(h.heroId)))row.reasons.push('HERO_OUTSIDE_TRAIN_VOCABULARY');else row.pairedEligible=true;}
  row.reasons=[...new Set(row.reasons)].sort();
 }
 rows.sort((a,b)=>cmp(a.matchId,b.matchId));
 const partitions=Object.fromEntries(Object.entries(protocol.partitions).map(([name,p])=>{
  const all=rows.filter(r=>r.nominalWindow===name),paired=all.filter(r=>r.pairedEligible),baseline=all.filter(r=>r.baselineEligible);
  return [name,{plannedDenominator:p.plannedDenominator,plannedMaps:p.maps,baselineMaps:baseline.length,pairedMaps:paired.length,
   pairedSeries:new Set(paired.map(r=>r.seriesKey)).size,pairedCoverage:p.plannedDenominator?paired.length/p.plannedDenominator:null,
   labels:{teamAWins:paired.filter(r=>r.label.teamAWon).length,teamBWins:paired.filter(r=>!r.label.teamAWon).length},
   reasons:Object.fromEntries([...new Set(all.flatMap(r=>r.reasons))].sort().map(reason=>[reason,all.filter(r=>r.reasons.includes(reason)).length]))}];
 }));
 const dataReasons=[],floors=policy.sampleFloors;
 for(const [name,min] of [['train',floors.trainMaps],['validation',floors.validationMaps],['calibration',floors.calibrationMaps],['development_test',floors.developmentTestMaps]]){
  const p=partitions[name];if(p.pairedMaps<min)dataReasons.push(name.toUpperCase()+'_MAPS_BELOW_FLOOR');
  if(Math.min(p.labels.teamAWins,p.labels.teamBWins)<floors.minEachLabelPerFittedOrScoredBlock)dataReasons.push(name.toUpperCase()+'_LABELS_BELOW_FLOOR');
 }
 if(partitions.development_test.pairedSeries<floors.developmentTestSeries)dataReasons.push('DEVELOPMENT_TEST_SERIES_BELOW_FLOOR');
 if((partitions.development_test.pairedCoverage??0)<0.80)dataReasons.push('DEVELOPMENT_TEST_COVERAGE_BELOW_0_80');
 return {format:'conditional-post-draft-dataset-v1',protocolFingerprint:protocol.fingerprint,policy,syntheticOnly:source.syntheticOnly,
  evaluationBasis:policy.evaluationBasis,deployable:false,trainingRunCreated:false,evaluation:'not_performed',
  featureSchemaVersion:'conditional-elo-signed-heroes-v1',heroVocabulary:vocabulary,partitions,
  dataChecks:{status:dataReasons.length?'insufficient':'passed_data_floors_only',reasons:dataReasons,modelQualityGate:'not_evaluated',activationAllowed:false},
  history:{fingerprint:history.sourceFingerprint,eligibleMaps:history.maps.length,assessments:prepared.report.assessments},
  rows:rows.map(({label,...row})=>row),labels:rows.filter(r=>r.label!==null).map(r=>({matchId:r.matchId,...r.label}))};
}
