import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {HistoricalImportConfigSchema} from '../../packages/contracts/dist/v1-historical-import.js';
import {HeroesSchema,LeaguesSchema} from '../../packages/ingestion/dist/opendota/schemas.js';
import {parseSource,classifyLeague} from '../../packages/ingestion/dist/quality.js';
import {historyAccountReviews} from '../../packages/ingestion/dist/history-enrichment.js';
import {prepareCurrentProfile} from '../../packages/ingestion/dist/opendota/current-profile.js';
import {prepareV1MapHistory,verifyV1Data} from '../../packages/db/dist/v1-data.js';
import {canonicalContextJson} from '../../packages/db/dist/temporal.js';
import {withHistoricalStore,readHistoricalRecords,historicalDeferredSources,validateHistoricalInventory} from './v1-historical-store.mjs';
import {reviewHistoricalCollection,hash,order} from './v1-historical-collection.mjs';
import {bounded,save,sha} from './v1-historical-protocol.mjs';
const fail=code=>{throw Error('historical_import_'+code);};
const same=(a,b)=>canonicalContextJson(a)===canonicalContextJson(b);
export function referenceObservation(value,endpoint,schema,now){
 const s=value?.source;
 if(!s||s.provider!=='opendota'||s.endpoint!==endpoint||s.knownAt!==null||typeof value.rawBody!=='string'||
  sha(value.rawBody)!==s.payloadSha256||!Number.isFinite(Date.parse(s.fetchedAt))||s.fetchedAt>now||!/^opendota-/.test(s.adapterVersion??''))fail('reference_binding');
 return {source:s,rawBody:value.rawBody,data:schema.parse(JSON.parse(value.rawBody))};
}
export function numericImportReviews(registry,profiles,accounts,reviewedAt){
 const result=historyAccountReviews(registry,accounts,reviewedAt),reviews=new Map(result.reviews.map(r=>[r.accounts[0].accountId,r])),rejected=[];
 for(const id of result.unresolved){
  const p=profiles.find(p=>p.accountId===id);
  if(!p){rejected.push({accountId:id,reason:'PROFILE_MISSING'});continue;}
  try{const prepared=prepareCurrentProfile({schemaVersion:1,mode:'current_profile_capture',accountId:id,observation:p.observation},p.sha256,{accountIds:[id],reviewedAt});
   reviews.set(id,prepared.review);
  }catch{rejected.push({accountId:id,reason:'NUMERIC_PROFILE_UNVERIFIED'});}
 }
 return {reviews:[...reviews.values()].sort((a,b)=>order(a.accounts[0].accountId,b.accounts[0].accountId)),rejected};
}
export async function historicalImportInputs(configPath,digest,reviewedAt=new Date().toISOString()){
 if(new Date(reviewedAt).toISOString()!==reviewedAt||reviewedAt>new Date().toISOString())fail('clock');
 const config=HistoricalImportConfigSchema.parse((await bounded(configPath,262144,digest)).data);
 return withHistoricalStore(config.collection.directory,config.collection.sha256,async ctx=>{
  if(ctx.config.syntheticOnly)fail('synthetic_collection');
  const records=await readHistoricalRecords(ctx);ctx.deferred=await historicalDeferredSources(ctx,records);validateHistoricalInventory(ctx,records,reviewedAt);
  const manifest=(await bounded(config.sourceManifest.path,2097152,config.sourceManifest.sha256)).data;
  for(const group of ['records','attempts']){
   const names=(await readdir(join(ctx.root,group))).sort();
   if(!same(names,manifest[group]?.map(r=>r.name).sort()))fail('source_inventory');
   for(const ref of manifest[group])if(sha(await readFile(join(ctx.root,group,ref.name)))!==ref.sha256)fail('source_sha');
  }
  const report=reviewHistoricalCollection(ctx,records,reviewedAt);
  if(report.summary.settledTargetMaps!==report.summary.observedMaps||report.summary.pendingHistoryMaps||report.summary.missingHistoryJobs)fail('collection_incomplete');
  const heroes=referenceObservation((await bounded(config.heroes.path,16777216,config.heroes.sha256)).data,'/heroes',HeroesSchema,reviewedAt);
  const protocolInputs=(await bounded(ctx.config.protocolInputs.path,65536,ctx.config.protocolInputs.sha256)).data;
  const leagueRef=protocolInputs.catalogue;
  const leagues=referenceObservation((await bounded(leagueRef.path,16777216,leagueRef.sha256)).data,'/leagues',LeaguesSchema,reviewedAt);
  const registry=(await bounded(config.registry.path,16777216,config.registry.sha256)).data;
  const profiles=[];for(const p of config.profiles)profiles.push({...p,observation:(await bounded(p.path,2097152,p.sha256)).data});
  const maps=[...records.entries()].filter(([key])=>key.startsWith('map-')).map(([key,r])=>{
   const matchId=key.slice(4),parsed=parseSource(r.observation,matchId),matches=leagues.data.filter(l=>l.leagueid===parsed.match?.leagueid);
   const reasons=[...parsed.issues];if(matches.length!==1||classifyLeague(matches[0]?.tier)!==true)reasons.push('PRO_STATUS_UNVERIFIED');
   return {matchId,observation:r.observation,map:parsed.match,reasons,sourceFingerprint:r.fingerprint};
  }).sort((a,b)=>order(a.matchId,b.matchId));
  const accounts=[...new Set(maps.filter(m=>m.reasons.length===0).flatMap(m=>(m.map.players??[]).flatMap(p=>p.account_id&&BigInt(p.account_id)<4294967295n?[p.account_id]:[])))].sort(order);
  const identities=numericImportReviews(registry,profiles,accounts,reviewedAt);
  const body={schemaVersion:1,format:'v1-historical-import-plan-v1',config:{path:configPath,sha256:digest},reviewedAt,
   protocolFingerprint:ctx.plan.fingerprint,collectionReport:report,
   maps:maps.map(m=>({matchId:m.matchId,payloadSha256:m.observation.source.payloadSha256,sourceFingerprint:m.sourceFingerprint,reasons:m.reasons})),
   accounts,identityReviews:identities.reviews,unresolvedProfiles:identities.rejected,
   canonicalBaseIds:ctx.canonical.source.candidates.map(m=>m.matchId).sort(order),syntheticOnly:false,
   historyWindow:{fromAt:ctx.canonical.source.request.fromAt,toAt:ctx.canonical.source.request.toAt,maxMaps:ctx.canonical.source.request.maxMaps},
   providerSeriesIds:[...new Set(maps.filter(m=>m.reasons.length===0).flatMap(m=>m.map.series_id??[]))].sort(order),
   importPolicy:'existing-canonical-importer-current-numeric-identities-v1',providerRequests:0,evaluationPerformed:false,deployable:false};
  const plan={...body,fingerprint:hash(body)};
  return {plan,ctx,maps,heroes,leagues};
 });
}
export async function readHistoricalImportPlan(path,digest){
 const saved=(await bounded(path,16777216,digest)).data;
 const inputs=await historicalImportInputs(saved.config.path,saved.config.sha256,saved.reviewedAt);
 if(!same(saved,inputs.plan))fail('plan_replay');return inputs;
}
export function historicalImportProvider(inputs){
 return {getHeroes:async()=>inputs.heroes,getLeagues:async()=>inputs.leagues,getMatchSource:async id=>{
  const m=inputs.maps.find(m=>m.matchId===id);if(!m||m.reasons.length)fail('map_outside_plan');return m.observation;
 }};
}
export function reconcileHistoricalImport(plan,datasetInput){
 const dataset=verifyV1Data(datasetInput),request=dataset.source.request;
 if(!same(plan.historyWindow,{fromAt:request.fromAt,toAt:request.toAt,maxMaps:request.maxMaps})||dataset.source.syntheticOnly!==plan.syntheticOnly)fail('dataset_scope');
 const allowed=new Set([...plan.canonicalBaseIds,...plan.maps.map(m=>m.matchId)]);
 if(dataset.source.candidates.some(m=>!allowed.has(m.matchId)))fail('unexpected_canonical_map');
 for(const m of dataset.source.candidates){const captured=plan.maps.find(p=>p.matchId===m.matchId);
  if(captured&&m.outcome.status==='verified'&&m.outcome.sourceEvidence.payloadSha256!==captured.payloadSha256)fail('history_source_binding');
 }
 const history=prepareV1MapHistory(dataset.source);
 const sourcePlan=new Map(plan.maps.map(m=>[m.matchId,m])),maps=new Map(dataset.source.candidates.map(m=>[m.matchId,m]));
 const assessments=new Map(history.report.assessments.map(a=>[a.matchId,a])),examples=new Map(history.report.examples.map(e=>[e.matchId,e]));
 const rows=plan.collectionReport.rows.map(original=>{
  const map=maps.get(original.matchId),a=assessments.get(original.matchId),e=examples.get(original.matchId),source=sourcePlan.get(original.matchId);
  // Source-only missing identity/history diagnostics are replaced by canonical checks; keep all original source/metadata failures.
  const reasons=original.reasons.filter(r=>!['CURRENT_CANONICAL_IDENTITIES_UNVERIFIED','EARLIER_HISTORY_BELOW_MINIMUM','SERIES_NOT_READY'].includes(r));
  if(!map)reasons.push('CANONICAL_MAP_MISSING');
  if(a&&!a.dataEligible)reasons.push(...a.reasons);
  if(map&&(!source||map.outcome.status!=='verified'||map.outcome.sourceEvidence.payloadSha256!==source.payloadSha256))reasons.push('CANONICAL_SOURCE_UNBOUND');
  const counts=e?.historyCoverage.priorMapsPerPlayer??null;
  if(!counts||counts.length!==10||counts.some(n=>n<5))reasons.push('CANONICAL_HISTORY_BELOW_MINIMUM');
  if(a?.seriesKey&&a.seriesKey!==`opendota:${original.seriesId}`)reasons.push('CANONICAL_SERIES_MISMATCH');
  return {matchId:original.matchId,seriesId:original.seriesId,exposureExcluded:original.exposureExcluded,canonicalEligible:a?.dataEligible??false,
   priorCanonicalMapsPerPlayer:counts,reasons:[...new Set(reasons)].sort(),ready:reasons.length===0};
 });
 const groups=new Map();for(const row of rows){if(row.seriesId!==null){const group=groups.get(row.seriesId)??[];group.push(row);groups.set(row.seriesId,group);}}
 for(const group of groups.values())if(group.some(r=>!r.ready))for(const r of group){r.ready=false;r.reasons=[...new Set([...r.reasons,'SERIES_NOT_READY'])].sort();}
 const target=rows.filter(r=>!r.exposureExcluded),ready=target.filter(r=>r.ready);
 return {schemaVersion:1,format:'v1-historical-canonical-review-v1',planFingerprint:plan.fingerprint,datasetFingerprint:dataset.fingerprint,
  snapshotAt:dataset.source.request.snapshotAt,summary:{inventoryMaps:maps.size,historyEligibleMaps:history.report.summary.eligibleMaps,
   targetMaps:target.length,targetSeries:new Set(target.map(r=>r.seriesId).filter(Boolean)).size,canonicalTargetMaps:target.filter(r=>r.canonicalEligible).length,
   historyReadyMaps:target.filter(r=>r.priorCanonicalMapsPerPlayer?.every(n=>n>=5)).length,readyMaps:ready.length,readySeries:new Set(ready.map(r=>r.seriesId)).size},
  rows,historyAssumptions:history.report.assumptions,qualityGateCalculated:false,evaluationPerformed:false,metrics:null,teamAWinProbability:null,deployable:false};
}
export {save,sha};
