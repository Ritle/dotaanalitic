import {RetestCollectionConfigSchema} from '../../packages/contracts/dist/v1-retest-collection.js';
import {HistoricalCacheSchema} from '../../packages/contracts/dist/v1-historical-collection.js';
import {verifyV1Data} from '../../packages/db/dist/v1-data.js';
import {LeaguesSchema} from '../../packages/ingestion/dist/opendota/schemas.js';
import {readRetestInputs,verifyRetestProtocol,retestMetadata,bounded,sha} from './v1-retest-protocol.mjs';
import {assessHistoricalMap,historicalHistoryJobs,decodeHistoricalHistory,reviewHistoricalCollection,hash,order} from './v1-historical-collection.mjs';
export const fail=code=>{throw Error('retest_collection_'+code);};
export async function loadRetestCollection(path,expectedSha){
 const config=RetestCollectionConfigSchema.parse((await bounded(path,65536,expectedSha)).data);
 const inputs=await readRetestInputs(config.protocolInputs.path,config.protocolInputs.sha256);
 const plan=verifyRetestProtocol((await bounded(config.protocol.path,4194304,config.protocol.sha256)).data,inputs);
 const canonical=verifyV1Data((await bounded(config.canonicalHistory.path,67108864,config.canonicalHistory.sha256)).data);
 if(canonical.source.syntheticOnly!==config.syntheticOnly||plan.syntheticOnly!==config.syntheticOnly)fail('synthetic_binding');
 if(config.maxRequestsPerRun!==plan.collection.maxRequestsPerRun||config.historyPolicy.windowDays!==plan.collection.historyWindowDays||
   config.historyPolicy.maxMapsPerAccount!==plan.collection.historyMaxMapsPerAccount)fail('policy_binding');
 const exposure={capturedAt:[inputs.fileExposure.capturedAt,inputs.databaseExposure.capturedAt].sort().at(-1),
  blockedMatchIds:[...new Set([...inputs.fileExposure.potentialMapIds,...inputs.databaseExposure.maps.map(r=>r.matchId)])].sort(order),
  opendotaSeriesIds:[...new Set([...inputs.fileExposure.opendotaSeriesIds,...inputs.databaseExposure.maps.filter(r=>r.provider==='opendota'&&r.providerSeriesId).map(r=>r.providerSeriesId)])].sort(order)};
 const metadata=retestMetadata(inputs.intent,exposure,inputs.captures,inputs.proposal.checkedAt);
 if(hash(metadata.ledger)!==plan.metadata.ledgerFingerprint)fail('metadata_binding');
 const review={checkedAt:inputs.proposal.checkedAt,ledger:metadata.ledger.map(r=>({matchId:r.matchId,leagueId:r.leagueId,
  providerSeriesId:r.seriesId,startTime:r.startTime,radiantTeamId:r.radiantTeamId,direTeamId:r.direTeamId,
  inTargetWindow:r.startTime===null?null:!r.outsideWindow,exposureExcluded:r.priorExposure,reasons:r.reasons,metadataCandidate:r.metadataCandidate}))};
 return {config,configSha:expectedSha,inputs,plan,review,exposure,canonical,
  cache:HistoricalCacheSchema.parse((await bounded(config.cache.path,4194304,config.cache.sha256)).data),
  catalogue:LeaguesSchema.parse(JSON.parse(inputs.catalogue.rawBody))};
}
export const deadlineReached=(ctx,now)=>now>=ctx.plan.collection.collectionDeadline;
export function terminalKey(ctx,state,key,now){
 if(state.records.has(key))return true;
 const attempts=state.admissions.filter(r=>r.key===key),limit=key.startsWith('map-')?ctx.plan.collection.maxDetailAttemptsPerMap:ctx.config.maxHistoryHttpAttempts;
 return deadlineReached(ctx,now)||attempts.length>=limit||state.outcomes.some(r=>r.key===key&&r.httpStatus===404);
}
export function collectionInventory(ctx,state,now){
 ctx.deferred=new Map();
 for(const key of new Set([...ctx.review.ledger.map(r=>'map-'+r.matchId),...state.admissions.map(r=>r.key)])){
  if(!state.records.has(key)&&terminalKey(ctx,state,key,now))ctx.deferred.set(key,
   state.outcomes.filter(o=>o.key===key).length?state.outcomes.filter(o=>o.key===key):[{httpStatus:null}]);
 }
 const maps=[...state.records].filter(([k])=>k.startsWith('map-')).map(([k,r])=>assessHistoricalMap(ctx,k.slice(4),r.observation,now));
 const jobs=historicalHistoryJobs(ctx,maps),allowedMaps=new Set(ctx.review.ledger.map(r=>r.matchId)),historyKeys=new Set(jobs?.map(j=>j.key)??[]);
 for(const [key,r] of state.records)if(key.startsWith('history-')){
  const job=jobs?.find(j=>j.key===key);if(!job)fail('history_scope');
  for(const row of decodeHistoricalHistory(job,r.observation,now).rows)allowedMaps.add(row.match_id);
 }
 if(allowedMaps.size>ctx.plan.request.maxInventoryMaps)fail('inventory_limit');
 const validKey=key=>key.startsWith('map-')?allowedMaps.has(key.slice(4)):historyKeys.has(key);
 if([...state.records.keys(),...state.admissions.map(r=>r.key)].some(k=>!validKey(k)))fail('key_scope');
 for(const a of state.admissions){const expected=a.key.startsWith('map-')?`/matches/${a.key.slice(4)}`:jobs.find(j=>j.key===a.key).endpoint;if(a.endpoint!==expected)fail('admission_endpoint');}
 for(const id of allowedMaps)if(!state.records.has('map-'+id)&&terminalKey(ctx,state,'map-'+id,now)&&!ctx.deferred.has('map-'+id))ctx.deferred.set('map-'+id,[{httpStatus:null}]);
 const terminal=jobs!==null&&[...allowedMaps].every(id=>terminalKey(ctx,state,'map-'+id,now))&&jobs.every(j=>terminalKey(ctx,state,j.key,now));
 return {maps,jobs,allowedMaps,terminal};
}
export function reviewRetestCollection(ctx,state,now){
 const inventory=collectionInventory(ctx,state,now),base=reviewHistoricalCollection(ctx,state.records,now);
 const unavailableSources=[...new Set([...inventory.allowedMaps].map(id=>'map-'+id).concat(inventory.jobs?.map(j=>j.key)??[]))]
  .filter(key=>!state.records.has(key)&&terminalKey(ctx,state,key,now)).map(key=>({key,
   attempts:state.admissions.filter(r=>r.key===key).length,lastStatus:state.outcomes.filter(r=>r.key===key).at(-1)?.httpStatus??null,
   reason:deadlineReached(ctx,now)?'collection_deadline':state.outcomes.some(r=>r.key===key&&r.httpStatus===404)?'source_not_found':'attempt_limit'}));
 if(deadlineReached(ctx,now))for(const row of base.rows)if(!state.records.has('map-'+row.matchId))row.reasons=[...new Set([...row.reasons,'COLLECTION_DEADLINE'])].sort();
 return {...base,schemaVersion:2,format:'retest-collection-review-v2',unavailableSources,
  collection:{terminal:inventory.terminal,deadlineReached:deadlineReached(ctx,now),deadline:ctx.plan.collection.collectionDeadline,
   httpAttempts:state.admissions.length,cacheRecords:[...state.records.values()].filter(r=>r.origin==='cache').length,
   liveRecords:[...state.records.values()].filter(r=>r.origin==='live').length,
   interruptedAttempts:state.outcomes.filter(o=>o.status==='interrupted').length,
   lateResponses:state.outcomes.filter(o=>o.status==='late_response').length,
   terminalHistoryJobs:inventory.jobs?.filter(j=>terminalKey(ctx,state,j.key,now)).length??0,
   pendingHistoryJobs:inventory.jobs?.filter(j=>!terminalKey(ctx,state,j.key,now)).length??null},
  qualityGateCalculated:false,evaluationPerformed:false,metrics:null,teamAWinProbability:null,deployable:false};
}
export {assessHistoricalMap,decodeHistoricalHistory,hash,order,bounded,sha};
