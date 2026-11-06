import {HistoricalCollectionConfigSchema,HistoricalCacheSchema,HistoricalObservationSchema,HistoricalMapSchema} from '../../packages/contracts/dist/v1-historical-collection.js';
import {canonicalContextJson} from '../../packages/db/dist/temporal.js';
import {verifyV1Data,prepareV1MapHistory} from '../../packages/db/dist/v1-data.js';
import {resolveIdentity} from '../../packages/db/dist/identity.js';
import {LeaguesSchema} from '../../packages/ingestion/dist/opendota/schemas.js';
import {playerHistoryQuery,PlayerHistoryRowsSchema,validatePlayerHistoryPage} from '../../packages/ingestion/dist/player-history.js';
import {readHistoricalInputs,readHistoricalCaptures,verifyHistoricalProtocol,inspectHistoricalDiscovery,bounded,sha} from './v1-historical-protocol.mjs';
export const hash=v=>sha(canonicalContextJson(v));
export const order=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
export const fail=code=>{throw Error('historical_collection_'+code);};
const slots=[0,1,2,3,4,128,129,130,131,132];
export function decodeObservation(input,endpoint,now){
 const observation=HistoricalObservationSchema.parse(input);
 if(observation.source.endpoint!==endpoint||sha(observation.rawBody)!==observation.source.payloadSha256||observation.source.fetchedAt>now)fail('source_binding');
 const raw=JSON.parse(observation.rawBody);
 if(raw&&typeof raw==='object'&&('synthetic' in raw||'_fixture' in raw))fail('synthetic_source');
 return {observation,raw};
}
export async function loadHistoricalCollection(configPath,expectedSha){
 const config=HistoricalCollectionConfigSchema.parse((await bounded(configPath,65536,expectedSha)).data);
 const inputs=await readHistoricalInputs(config.protocolInputs.path,config.protocolInputs.sha256);
 const plan=verifyHistoricalProtocol((await bounded(config.protocol.path,4194304,config.protocol.sha256)).data,inputs.catalogue,inputs.exposure,inputs.request);
 const review=(await bounded(config.discoveryReview.path,16777216,config.discoveryReview.sha256)).data;
 const rebuilt=inspectHistoricalDiscovery(plan,inputs.catalogue,inputs.exposure,await readHistoricalCaptures(config.discoveryCaptures.path,config.discoveryCaptures.sha256),review.checkedAt);
 if(canonicalContextJson(review)!==canonicalContextJson(rebuilt)||review.missingEvents.length)fail('discovery_replay');
 const cache=HistoricalCacheSchema.parse((await bounded(config.cache.path,4194304,config.cache.sha256)).data);
 const canonical=verifyV1Data((await bounded(config.canonicalHistory.path,67108864,config.canonicalHistory.sha256)).data);
 if(canonical.source.request.snapshotAt>new Date().toISOString())fail('canonical_clock');
 if(canonical.source.syntheticOnly!==config.syntheticOnly||plan.syntheticOnly!==config.syntheticOnly)fail('synthetic_binding');
 const catalogue=LeaguesSchema.parse(JSON.parse(inputs.catalogue.rawBody));
 return {config,configSha:expectedSha,plan,review,cache,canonical,catalogue,exposure:inputs.exposure};
}
export function assessHistoricalMap(ctx,id,input,now){
 if(!input)return {matchId:id,map:null,sourceEligible:false,reasons:['DETAIL_MISSING'],source:null};
 const {observation,raw}=decodeObservation(input,`/matches/${id}`,now),parsed=HistoricalMapSchema.safeParse(raw);
 if(!parsed.success)return {matchId:id,map:null,sourceEligible:false,reasons:['SOURCE_SCHEMA_INVALID'],source:observation.source};
 const m=parsed.data,reasons=[];
 if(m.match_id!==id)fail('source_id');
 if(m.start_time===null||m.start_time<=0||m.start_time>253402300799||m.duration===null||m.duration<=0||
   (m.start_time+m.duration)*1000>Date.parse(observation.source.fetchedAt)||m.radiant_win===null)reasons.push('COMPLETED_OUTCOME_REQUIRED');
 const leagues=ctx.catalogue.filter(l=>l.leagueid===m.leagueid);
 if(leagues.length!==1||!['professional','premium'].includes(leagues[0]?.tier))reasons.push('PRO_STATUS_UNVERIFIED');
 if(!m.radiant_team_id||!m.dire_team_id||m.radiant_team_id===m.dire_team_id)reasons.push('TEAM_CONTEXT_REQUIRED');
 if(!m.series_id)reasons.push('SERIES_ID_REQUIRED');
 if(m.lobby_type!==1)reasons.push('TOURNAMENT_LOBBY_REQUIRED');
 m.players.sort((a,b)=>(a.player_slot??-1)-(b.player_slot??-1));
 if(m.players.length!==10||m.players.some((p,i)=>p.player_slot!==slots[i]||p.account_id===null)||new Set(m.players.map(p=>p.account_id)).size!==10)reasons.push('ACTUAL_ACCOUNTS_INVALID');
 const row=ctx.review.ledger.find(r=>r.matchId===id);
 if(row&&[['leagueId','leagueid'],['providerSeriesId','series_id'],['startTime','start_time'],['radiantTeamId','radiant_team_id'],['direTeamId','dire_team_id']]
  .some(([a,b])=>row[a]!==null&&row[a]!==m[b]))reasons.push('DISCOVERY_DETAIL_CONFLICT');
 return {matchId:id,map:m,sourceEligible:reasons.length===0,reasons,source:observation.source};
}
export function historicalHistoryJobs(ctx,assessments){
 if(ctx.review.ledger.some(r=>!assessments.some(a=>a.matchId===r.matchId&&a.source)&&!ctx.deferred?.has('map-'+r.matchId)))return null;
 const selected=new Set(ctx.review.ledger.filter(r=>!r.exposureExcluded).map(r=>r.matchId));
 const accounts=[...new Set(assessments.filter(a=>selected.has(a.matchId)&&a.sourceEligible).flatMap(a=>a.map.players.map(p=>p.account_id)))].sort(order);
 const cutoffAt=ctx.plan.request.events.map(e=>e.fromAt).sort()[0],options={windowDays:730,maxMaps:10},page={limit:10,cursors:{}};
 return Array.from({length:Math.ceil(accounts.length/5)},(_,i)=>{const ids=accounts.slice(i*5,i*5+5);
  return {key:`history-${String(i).padStart(3,'0')}`,accounts:ids,cutoffAt,options,page,
   endpoint:'/explorer?'+new URLSearchParams({sql:playerHistoryQuery(ids,cutoffAt,options,page)}).toString()};});
}
export function decodeHistoricalHistory(job,input,now){
 const {observation,raw}=decodeObservation(input,job.endpoint,now);
 if(raw?.err!==null)fail('history_query_failed');
 const rows=PlayerHistoryRowsSchema.parse(raw.rows);validatePlayerHistoryPage(rows,job.accounts,job.cutoffAt,job.options,job.page);
 return {rows,source:observation.source};
}
/** Source readiness only; no Elo call, labels in report or canonical writes. */
export function reviewHistoricalCollection(ctx,records,now){
 const allMaps=[...records.entries()].filter(([key])=>key.startsWith('map-')).map(([key,record])=>assessHistoricalMap(ctx,key.slice(4),record.observation,now));
 const targetRows=ctx.review.ledger.map(r=>({...r,assessment:allMaps.find(a=>a.matchId===r.matchId)??assessHistoricalMap(ctx,r.matchId,null,now)}));
 const jobs=historicalHistoryJobs(ctx,allMaps),historyRows=[],missingJobs=[];
 for(const job of jobs??[]){const record=records.get(job.key);if(!record){missingJobs.push(job.key);continue;}historyRows.push(...decodeHistoricalHistory(job,record.observation,now).rows);}
 // One map may appear for five accounts. Its detail is requested and counted once.
 const historyIds=[...new Set(historyRows.map(r=>r.match_id))].sort(order);
 const invalidHistory=new Set(),missingHistory=new Set();
 for(const id of historyIds){const a=allMaps.find(m=>m.matchId===id),m=a?.map;
  if(!a){missingHistory.add(id);continue;}
  if(!a?.sourceEligible||historyRows.filter(r=>r.match_id===id).some(r=>r.leagueid!==m.leagueid||r.start_time!==m.start_time||r.duration!==m.duration||r.radiant_win!==m.radiant_win||
    !m.players.some(p=>p.account_id===r.account_id&&p.player_slot===r.player_slot)))invalidHistory.add(id);
 }
 const knownSeries=new Map();
 for(const row of targetRows)for(const id of new Set([row.providerSeriesId,row.assessment.map?.series_id].filter(Boolean))){const group=knownSeries.get(id)??[];group.push(row);knownSeries.set(id,group);}
 const exposed=new Set(ctx.exposure.blockedMatchIds),exposedSeries=new Set(ctx.exposure.opendotaSeriesIds),excluded=new Set(targetRows.filter(r=>r.exposureExcluded||exposed.has(r.matchId)).map(r=>r.matchId));
 // A detail may recover a previously unknown series. Propagate across both observed aliases.
 let changed=true;while(changed){changed=false;for(const [id,group] of knownSeries)if(exposedSeries.has(id)||group.some(r=>excluded.has(r.matchId)))for(const r of group)if(!excluded.has(r.matchId)){excluded.add(r.matchId);changed=true;}}
 const history=new Map();
 const add=(id,start,end,accounts,win,basis)=>{if(start<Date.parse(ctx.plan.request.warmupFromAt)||end<=start||end>Date.parse(now))return;
  if(history.has(id)){const old=history.get(id);if(old.start!==start||old.end!==end||old.win!==win||canonicalContextJson(old.accounts)!==canonicalContextJson(accounts))fail('history_source_conflict');return;}
  history.set(id,{start,end,accounts,win,basis});};
 const canonical=prepareV1MapHistory(ctx.canonical.source);
 for(const a of canonical.report.assessments.filter(a=>a.dataEligible)){
  const m=canonical.source.candidates.find(m=>m.matchId===a.matchId);
  add(m.matchId,Number(BigInt(m.startedAtUs)/1000n),Number(BigInt(m.endedAtUs)/1000n),m.players.map(p=>p.sourceAccountId),m.radiantWin,'canonical_verified');
 }
 for(const a of allMaps.filter(a=>a.sourceEligible&&!invalidHistory.has(a.matchId))){const m=a.map;
  if(ctx.review.ledger.some(r=>r.matchId===a.matchId)||historyIds.includes(a.matchId))add(a.matchId,m.start_time*1000,(m.start_time+m.duration)*1000,m.players.map(p=>p.account_id),m.radiant_win,'source_only');
 }
 const facts=ctx.canonical.source.identities.filter(i=>i.fetchedAt<=now&&(i.knownAt===null||i.knownAt<=now));
 const rows=targetRows.map(r=>{const a=r.assessment,m=a.map,reasons=[...a.reasons,...r.reasons.filter(reason=>reason!=='SERIES_ID_PENDING'||!m?.series_id)];
  if(!a.source&&ctx.deferred?.has('map-'+r.matchId))reasons.push('SOURCE_UNAVAILABLE_AFTER_BOUNDED_ATTEMPTS');
  if(excluded.has(r.matchId))reasons.push('PRIOR_EXPOSURE_WHOLE_SERIES');
  if(r.inTargetWindow!==true)reasons.push('TARGET_WINDOW_UNRESOLVED');
  const counts=m?.players.length===10?m.players.map(p=>[...history.entries()].filter(([id,h])=>id!==r.matchId&&h.end<m.start_time*1000&&h.accounts.includes(p.account_id)).length):null;
  const identities=m?.players.map(p=>p.account_id?resolveIdentity(facts,p.account_id,null):{status:'unknown',playerId:null})??[];
  const identityReady=identities.length===10&&identities.every(i=>i.status==='verified')&&new Set(identities.map(i=>i.playerId)).size===10;
  if(!identityReady)reasons.push('CURRENT_CANONICAL_IDENTITIES_UNVERIFIED');
  if(!counts||counts.some(n=>n<5))reasons.push('EARLIER_HISTORY_BELOW_MINIMUM');
  return {matchId:r.matchId,seriesId:m?.series_id??r.providerSeriesId,exposureExcluded:excluded.has(r.matchId),sourceEligible:a.sourceEligible,
   currentIdentitiesVerified:identityReady,priorSourceMapsPerPlayer:counts,reasons:[...new Set(reasons)].sort(),ready:false};});
 for(const group of knownSeries.values())if(group.some(r=>!r.assessment.sourceEligible||r.inTargetWindow!==true))for(const r of group)rows.find(a=>a.matchId===r.matchId).reasons.push('OBSERVED_SERIES_HAS_UNREADY_MEMBER');
 for(const row of rows)row.ready=row.reasons.length===0;
 // A whole test series must have valid history and identity coverage on every map.
 changed=true;while(changed){changed=false;for(const group of knownSeries.values())if(group.some(r=>!rows.find(a=>a.matchId===r.matchId).ready))for(const r of group){const row=rows.find(a=>a.matchId===r.matchId);if(row.ready){row.ready=false;changed=true;}if(!row.reasons.includes('SERIES_NOT_READY'))row.reasons.push('SERIES_NOT_READY');}}
 const target=rows.filter(r=>!r.exposureExcluded),series=new Set(target.map(r=>r.seriesId).filter(Boolean));
 return {schemaVersion:1,format:'historical-collection-review-v1',protocolFingerprint:ctx.plan.fingerprint,configSha256:ctx.configSha,checkedAt:now,
  summary:{observedMaps:rows.length,capturedTargetMaps:targetRows.filter(r=>r.assessment.source).length,
   deferredTargetMaps:targetRows.filter(r=>!r.assessment.source&&ctx.deferred?.has('map-'+r.matchId)).length,
   settledTargetMaps:targetRows.filter(r=>r.assessment.source||ctx.deferred?.has('map-'+r.matchId)).length,sourceEligibleMaps:rows.filter(r=>r.sourceEligible).length,
   priorExposedMaps:rows.filter(r=>r.exposureExcluded).length,unexposedMaps:target.length,unexposedKnownSeries:series.size,
   sourceHistoryReadyMaps:target.filter(r=>r.priorSourceMapsPerPlayer?.every(n=>n>=5)).length,currentIdentityReadyMaps:target.filter(r=>r.currentIdentitiesVerified).length,
   provisionalReadyMaps:target.filter(r=>r.ready).length,historyJobs:jobs?.length??null,missingHistoryJobs:missingJobs.length,
   discoveredHistoryMaps:historyIds.length,capturedHistoryMaps:historyIds.filter(id=>records.has('map-'+id)).length,invalidHistoryMaps:invalidHistory.size,
   pendingHistoryMaps:[...missingHistory].filter(id=>!ctx.deferred?.has('map-'+id)).length,deferredHistoryMaps:[...missingHistory].filter(id=>ctx.deferred?.has('map-'+id)).length},
  rows,history:{policy:ctx.config.historyPolicy,cutoffAt:jobs?.[0]?.cutoffAt??null,missingJobs,requiredMapIds:historyIds,
   uniqueAvailableMaps:history.size,canonicalVerifiedMaps:[...history.values()].filter(h=>h.basis==='canonical_verified').length,
   cappedAccounts:jobs?.flatMap(j=>j.accounts.filter(a=>historyRows.filter(r=>r.account_id===a).length===10))??[],completeness:'bounded_sample_not_full_history'},
  unavailableSources:[...ctx.deferred??[]].map(([key,failures])=>({key,attempts:failures.length,lastStatus:failures.at(-1).httpStatus??null})),
  canonicalOutcomeEligibilityVerified:false,qualityGateCalculated:false,evaluationPerformed:false,metrics:null,teamAWinProbability:null,deployable:false};
}
