/** Offline request-ledger replay. No transport, database writes, scoring or collection authorization. */
import assert from 'node:assert/strict';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {EvaluationDiscoveryRowsSchema} from '../../packages/contracts/dist/index.js';
import {validateRealRegistrationPackage,realSha} from './conditional-real-registration.mjs';
export const registeredCollectorPaths=Object.freeze(['tools/research/conditional-registered-collector.mjs','tools/research/conditional-registered-collector-store.mjs']);
const Time=z.string().datetime({precision:3}),Uuid=z.string().uuid(),Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Base={sequence:z.number().int().nonnegative(),at:Time};
const Result=z.discriminatedUnion('status',[
 z.object({status:z.literal('captured'),rawBody:z.string().max(8388608).refine(s=>Buffer.byteLength(s)<=8388608,'response_byte_limit'),payloadSha256:Hash}).strict(),
 z.object({status:z.literal('failed'),httpStatus:z.number().int().min(400).max(599).nullable(),code:z.string().regex(/^[a-z_]{1,80}$/),retryAfterAt:Time.nullable()}).strict()]);
const Event=z.discriminatedUnion('kind',[
 z.object({...Base,kind:z.literal('scan_started'),scanId:Uuid}).strict(),
 z.object({...Base,kind:z.literal('request_started'),requestId:Uuid,endpoint:z.string().max(256)}).strict(),
 z.object({...Base,kind:z.literal('request_finished'),requestId:Uuid,result:Result}).strict()]);
export const RegisteredCollectionLogSchema=z.object({format:z.literal('conditional-registered-collection-v1'),registrationId:Uuid,
 registrationSha256:Hash,syntheticOnly:z.boolean(),snapshotAt:Time,events:z.array(Event).max(3000)}).strict();
const Registration=z.object({id:Uuid,packageText:z.string().max(33554432),packageSha256:Hash,recordedAt:Time,registeredAt:Time,
 status:z.literal('registered_plan_only'),clockBasis:z.literal('postgres_observed_commit')});
const cmp=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const metadataFields=['start_time','leagueid','series_id','radiant_team_id','dire_team_id'];
const seriesKey=id=>JSON.stringify(['opendota',id]);
function binding(raw){
 const r=Registration.parse(raw);assert.equal(realSha(r.packageText),r.packageSha256,'registration_package_hash');
 const p=JSON.parse(r.packageText),plan=validateRealRegistrationPackage(p,r.recordedAt);
 assert(r.registeredAt>=r.recordedAt,'receipt_clock_regression');validateRealRegistrationPackage(p,r.registeredAt);
 for(const path of registeredCollectorPaths)assert(p.executable.code[path],'collector_not_in_registered_manifest');
 return {r,p,plan};
}
export function replayRegisteredCollection(rawRegistration,rawLog,expectedLogSha){
 Hash.parse(expectedLogSha);assert.equal(realSha(JSON.stringify(rawLog)),expectedLogSha,'collection_log_hash');
 assert(Buffer.byteLength(JSON.stringify(rawLog))<=67108864,'collection_log_limit');
 const log=RegisteredCollectionLogSchema.parse(rawLog),{r,p,plan}=binding(rawRegistration);
 assert.equal(log.registrationId,r.id,'registration_id_mismatch');assert.equal(log.registrationSha256,r.packageSha256,'registration_hash_mismatch');
 assert(log.snapshotAt>=r.registeredAt,'snapshot_before_registration');
 const leagues=new Set(plan.scope.map(s=>s.leagueId)),excluded=JSON.parse(p.exposureText),excludedMaps=new Set(excluded.mapIds),excludedSeries=new Set(excluded.canonicalSeriesKeys);
 const observations=new Map(),possibleIds=new Set(),detailIds=new Set(),scans=[],requests=[],requestIds=new Set(),scanIds=new Set(),daily={};
 let current=null,pending=null,lastAt=r.registeredAt,cooldown=null,authFailed=false;
 const inWindow=x=>x===null?null:new Date(x*1000).toISOString()>=plan.window.from&&new Date(x*1000).toISOString()<plan.window.until;
 const potential=(row,league)=>(!!league||row.leagueid===null||leagues.has(row.leagueid))&&inWindow(row.start_time)!==false;
 for(const [index,e] of log.events.entries()){
  assert.equal(e.sequence,index,'event_sequence_gap');assert(e.at>=lastAt&&e.at<=log.snapshotAt,'event_clock_invalid');lastAt=e.at;
  if(e.kind==='scan_started'){
   assert(!pending,'scan_with_inflight_request');assert(!scanIds.has(e.scanId),'duplicate_scan');scanIds.add(e.scanId);
   current={scanId:e.scanId,startedAt:e.at,leagueResponses:[],globalStatus:'not_requested',cursor:null};scans.push(current);continue;
  }
  if(e.kind==='request_started'){
   assert(current,'scan_required');assert(!pending,'concurrent_request');assert(!requestIds.has(e.requestId),'duplicate_request');
   assert(e.at>=plan.window.from&&e.at<plan.window.assessmentAt,'collection_window_closed');
   assert(!cooldown||e.at>=cooldown,'retry_after_active');assert(!authFailed,'provider_auth_failed');
   assert(requests.length<plan.collection.maxHttpAttempts,'total_budget_exhausted');
   assert((daily[e.at.slice(0,10)]??0)<plan.collection.maxDailyAttempts,'daily_budget_exhausted');
   assert(possibleIds.size<=plan.collection.maxTargetMaps,'target_budget_exceeded');
   let kind,league=null,matchId=null;
   const leagueMatch=/^\/leagues\/([1-9]\d{0,18})\/matches$/.exec(e.endpoint),detail=/^\/matches\/([1-9]\d{0,18})$/.exec(e.endpoint);
   if(leagueMatch){league=leagueMatch[1];assert(leagues.has(league),'unregistered_league');kind='league';}
   else if(detail){matchId=detail[1];assert(possibleIds.has(matchId),'unknown_target_detail');kind='detail';}
   else {
    assert(current.globalStatus!=='exhausted','cursor_already_exhausted');
    const endpoint=current.cursor===null?'/proMatches':'/proMatches?less_than_match_id='+current.cursor;
    assert.equal(e.endpoint,endpoint,'global_cursor_mismatch');kind='global';
   }
   requestIds.add(e.requestId);daily[e.at.slice(0,10)]=(daily[e.at.slice(0,10)]??0)+1;
   pending={requestId:e.requestId,scanId:current.scanId,endpoint:e.endpoint,kind,league,matchId,startedAt:e.at,status:'in_flight',finishedAt:null,payloadSha256:null,reason:null};
   requests.push(pending);continue;
  }
  assert(pending&&pending.requestId===e.requestId,'completion_without_matching_request');const q=pending;pending=null;q.finishedAt=e.at;
  if(e.result.status==='failed'){
   q.status='failed';q.reason=e.result.code;q.httpStatus=e.result.httpStatus;q.retryAfterAt=e.result.retryAfterAt;
   const backoff=new Date(Date.parse(e.at)+5000).toISOString();cooldown=[cooldown??'',e.result.retryAfterAt??'',backoff].sort().at(-1);
   if([401,403].includes(e.result.httpStatus))authFailed=true;
   continue;
  }
  assert.equal(realSha(e.result.rawBody),e.result.payloadSha256,'response_bytes_changed');q.payloadSha256=e.result.payloadSha256;
  let rows;
  try{
   const raw=JSON.parse(e.result.rawBody);rows=EvaluationDiscoveryRowsSchema.parse(q.kind==='detail'?[raw]:raw);
   assert.equal(new Set(rows.map(x=>x.match_id)).size,rows.length,'duplicate_response_map');
   if(q.kind==='detail')assert.equal(rows[0].match_id,q.matchId,'detail_map_mismatch');
   if(q.kind==='global'&&current.cursor!==null)assert(rows.every(x=>BigInt(x.match_id)<BigInt(current.cursor)),'cursor_not_advancing');
  }catch{q.status='invalid_response';q.reason='invalid_response';continue;}
  q.status='captured';
  if(q.kind==='league'&&!current.leagueResponses.includes(q.league))current.leagueResponses.push(q.league);
  if(q.kind==='global'){
   if(!rows.length)current.globalStatus='exhausted';
   else{current.globalStatus='bounded';current.cursor=rows.map(x=>x.match_id).sort(cmp)[0];}
  }
  if(q.kind==='detail')detailIds.add(q.matchId);
  for(const row of rows){
   const list=observations.get(row.match_id)??[];
   list.push({row,requestId:q.requestId,scanId:q.scanId,endpoint:q.endpoint,league:q.league,fetchedAt:e.at,payloadSha256:q.payloadSha256});observations.set(row.match_id,list);
   if(potential(row,q.league))possibleIds.add(row.match_id);
  }
 }
 // Preserve all observations; derive exclusions separately, never shrink earlier observed inventory.
 const contaminatedSeries=new Set(excludedSeries),targetSeries=new Set();
 for(const [id,list] of observations)for(const o of list)if(o.row.series_id){
  if(excludedMaps.has(id))contaminatedSeries.add(seriesKey(o.row.series_id));
  if(possibleIds.has(id))targetSeries.add(o.row.series_id);
 }
 const maps=[...observations].sort(([a],[b])=>cmp(a,b)).map(([matchId,list])=>{
  const metadata={},reasons=new Set();
  for(const key of metadataFields){const values=[...new Set(list.map(o=>o.row[key]).filter(x=>x!==null))];metadata[key]=values.length===1?values[0]:null;if(values.length>1)reasons.add('METADATA_CONFLICT');}
  if(list.some(o=>o.league&&o.row.leagueid!==null&&o.row.leagueid!==o.league))reasons.add('LEAGUE_ENDPOINT_CONFLICT');
  if(metadata.start_time===null)reasons.add('START_UNKNOWN');else if(inWindow(metadata.start_time)===false)reasons.add('OUTSIDE_WINDOW');
  if(metadata.leagueid===null)reasons.add('EVENT_SCOPE_UNKNOWN');else if(!leagues.has(metadata.leagueid))reasons.add('FOREIGN_EVENT');
  if(metadata.series_id===null)reasons.add('SERIES_UNKNOWN');
  if(excludedMaps.has(matchId)||list.some(o=>o.row.series_id&&contaminatedSeries.has(seriesKey(o.row.series_id))))reasons.add('EXPOSED_MAP_OR_SERIES');
  const sibling=list.some(o=>o.row.series_id&&targetSeries.has(o.row.series_id));
  if(!detailIds.has(matchId))reasons.add('DETAIL_NOT_CAPTURED');
  return {matchId,metadata,startedAt:metadata.start_time===null?null:new Date(metadata.start_time*1000).toISOString(),
   possibleTarget:possibleIds.has(matchId),targetSeriesSibling:sibling,detailCaptured:detailIds.has(matchId),
   observations:list,eligibleForScoring:false,reasons:[...reasons].sort()};
 });
 const reasons=new Set(['DENOMINATOR_REQUIRES_REVIEWED_EVENT_REGISTER','DETAIL_CAPTURE_IS_NOT_PRO_VERIFICATION']);
 if(!current||[...leagues].some(id=>!current.leagueResponses.includes(id)))reasons.add('LATEST_LEAGUE_RESPONSE_MISSING');
 if(current?.globalStatus!=='exhausted')reasons.add('GLOBAL_SCAN_INCOMPLETE');
 if(log.snapshotAt<plan.window.until)reasons.add('TARGET_WINDOW_NOT_FINISHED');
 if(log.snapshotAt<plan.window.from)reasons.add('COLLECTION_NOT_STARTED');
 if(log.snapshotAt>=plan.window.assessmentAt)reasons.add('COLLECTION_WINDOW_CLOSED');
 if(pending)reasons.add('REQUEST_IN_FLIGHT');if(authFailed)reasons.add('PROVIDER_AUTH_FAILED');
 if(cooldown&&log.snapshotAt<cooldown)reasons.add('RETRY_AFTER');
 if(requests.length>=plan.collection.maxHttpAttempts)reasons.add('TOTAL_BUDGET_EXHAUSTED');
 if((daily[log.snapshotAt.slice(0,10)]??0)>=plan.collection.maxDailyAttempts)reasons.add('DAILY_BUDGET_EXHAUSTED');
 if(possibleIds.size>plan.collection.maxTargetMaps)reasons.add('TARGET_BUDGET_EXCEEDED');
 const stop=['COLLECTION_NOT_STARTED','COLLECTION_WINDOW_CLOSED','REQUEST_IN_FLIGHT','PROVIDER_AUTH_FAILED','RETRY_AFTER','TOTAL_BUDGET_EXHAUSTED','DAILY_BUDGET_EXHAUSTED','TARGET_BUDGET_EXCEEDED'];
 let nextRequest=null;
 if(!stop.some(code=>reasons.has(code))){
  const league=plan.scope.find(s=>!current?.leagueResponses.includes(s.leagueId)),missing=maps.find(m=>m.possibleTarget&&!m.detailCaptured&&!m.reasons.includes('EXPOSED_MAP_OR_SERIES'));
  const endpoint=league?'/leagues/'+league.leagueId+'/matches':missing?'/matches/'+missing.matchId:
   current?.globalStatus==='exhausted'?null:current?.cursor?'/proMatches?less_than_match_id='+current.cursor:'/proMatches';
  if(endpoint)nextRequest={endpoint,requiresScanStart:current===null,advisoryOnly:true};
 }
 const body={format:'conditional-registered-collection-report-v1',registrationId:r.id,registrationSha256:r.packageSha256,logSha256:expectedLogSha,
  syntheticOnly:log.syntheticOnly,snapshotAt:log.snapshotAt,scope:plan.scope,window:plan.window,exposureSnapshotSha256:plan.exposureSnapshotSha256,
  bindingBasis:'validated_supplied_registration_snapshot_not_database_attestation',
  attempts:{total:requests.length,byUtcDay:daily,failed:requests.filter(q=>q.status==='failed').length,invalidResponses:requests.filter(q=>q.status==='invalid_response').length},
  budget:plan.collection,cooldownUntil:cooldown,scans,requests,maps,observedPossibleMaps:possibleIds.size,verifiedProMaps:null,
  denominatorComplete:false,nextRequest,reasons:[...reasons].sort(),
  collectionAllowed:false,realEvaluationAllowed:false,activationAllowed:false,scoringPerformed:false,deployable:false};
 return {...body,fingerprint:realSha(JSON.stringify(body))};
}
export function appendRegisteredCollection(registration,previous,expectedHeadSha,events,snapshotAt){
 replayRegisteredCollection(registration,previous,expectedHeadSha);assert(snapshotAt>=previous.snapshotAt,'snapshot_clock_regression');
 assert(events.every(e=>e.at>=previous.snapshotAt),'append_clock_regression');
 const log=RegisteredCollectionLogSchema.parse({...previous,snapshotAt,events:[...previous.events,...events]});
 const sha256=realSha(JSON.stringify(log)),report=replayRegisteredCollection(registration,log,sha256);
 return {parentSha256:expectedHeadSha,sha256,log,report,persisted:false};
}
