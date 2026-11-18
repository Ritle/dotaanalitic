/** Read-only discovery replay; never imports maps, dispatches HTTP, scores or authorizes a model. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {EvaluationDiscoveryRowsSchema} from '../../packages/contracts/dist/index.js';
import {sql} from '../../packages/db/dist/index.js';
import {validateRegistrationV2} from './conditional-real-registration-v2.mjs';
import {ConditionalCollectionV2Journal,replayCollectionV2} from './conditional-collection-v2-journal.mjs';
import {archiveSha as sha,archiveBody,archiveMetadata,decodeArchiveBody} from './conditional-blob-archive.mjs';
import {parseBindingEvidenceJson as parse} from './conditional-tournament-binding-v2.mjs';
export const collectionV2DiscoveryPaths=['tools/research/conditional-collection-v2-discovery.mjs'];
const Time=z.string().datetime({precision:3}),Id=z.string().uuid(),Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Registration=z.object({id:Id,packageText:z.string().max(33554432),packageSha256:Hash,recordedAt:Time,registeredAt:Time,
 status:z.literal('registered_plan_only'),clockBasis:z.literal('postgres_observed_commit')});
const cmp=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0,iso=x=>new Date(x).toISOString();
const fields=['start_time','leagueid','series_id','radiant_team_id','dire_team_id'],seriesKey=id=>JSON.stringify(['opendota',id]);
const closed={collectionAllowed:false,dispatchAllowed:false,realEvaluationAllowed:false,activationAllowed:false,scoringPerformed:false,deployable:false};
export async function replayCollectionV2Discovery(evidence,readResponse){
 const r=Registration.parse(evidence.registration);assert.equal(sha(r.packageText),r.packageSha256,'discovery_registration_hash');
 const p=parse(r.packageText),plan=validateRegistrationV2(p,r.recordedAt);assert(r.registeredAt>=r.recordedAt,'registration_clock');
 validateRegistrationV2(p,r.registeredAt);for(const path of collectionV2DiscoveryPaths)Hash.parse(p.executable.code[path]);
 const state=replayCollectionV2({...r,plan},evidence.header,evidence.events,evidence.snapshotAt),leagues=new Set(plan.scope.map(s=>s.leagueId));
 const excluded=parse(p.exposureText),excludedMaps=new Set(excluded.mapIds),contaminated=new Set(excluded.canonicalSeriesKeys);
 const observations=new Map(),possible=new Set(),details=new Set(),leagueResponses=new Map(),requests=[],passes=[];
 let current=null,observationCount=0;
 const inWindow=value=>value===null?null:iso(value*1000)>=plan.window.from&&iso(value*1000)<plan.window.until;
 for(const q of state.requests){
  assert(possible.size<=plan.collection.maxTargetMaps,'discovery_target_budget_exceeded_before_request');
  const league=/^\/leagues\/(\d+)\/matches$/.exec(q.endpoint)?.[1]??null,matchId=/^\/matches\/(\d+)$/.exec(q.endpoint)?.[1]??null;
  const kind=league?'league':matchId?'detail':'global';
  if(matchId)assert(possible.has(matchId),'discovery_undiscovered_detail');
  if(kind==='global'){
   if(q.endpoint==='/proMatches'){
    if(current&&current.status!=='endpoint_end_observed')current.status='superseded_incomplete';
    current={rootRequestId:q.requestId,startedAt:q.startedAt,status:'not_completed',cursor:null,pageRequestIds:[]};passes.push(current);
   }else{assert(current&&current.status!=='endpoint_end_observed'&&current.cursor!==null,'discovery_cursor_without_page');
    assert.equal(q.endpoint,'/proMatches?less_than_match_id='+current.cursor,'discovery_cursor_mismatch');}
  }
  const request={requestId:q.requestId,endpoint:q.endpoint,kind,startedAt:q.startedAt,finishedAt:q.finishedAt,status:q.status,
   bodySha256:q.bodySha256??null,receiptSha256:q.receiptSha256??null,reason:null};requests.push(request);
  if(q.status!=='archived')continue;
  // Integrity failures abort replay; malformed provider payloads remain explicit invalid observations.
  const source=await readResponse(q);assert(source&&typeof source.metadataText==='string','discovery_receipt_missing');
  assert.equal(sha(source.metadataText),q.receiptSha256,'discovery_receipt_hash');const digest=archiveBody(source.bytes);
  assert.equal(digest.sha256,q.bodySha256,'discovery_body_hash');const metadata=parse(source.metadataText);
  assert.deepEqual(metadata,archiveMetadata(r.id,{requestId:q.requestId,endpoint:q.endpoint,httpStatus:metadata.httpStatus,
   receivedAt:q.receivedAt,clientValidationCode:metadata.clientValidationCode},digest,evidence.header.synthetic_only),'discovery_metadata_binding');
  let rows;
  try{
   const decoded=decodeArchiveBody(source.bytes);assert.equal(decoded.status,'utf8','invalid_utf8');const raw=parse(decoded.text);
   rows=EvaluationDiscoveryRowsSchema.parse(kind==='detail'?[raw]:raw);
   assert.equal(new Set(rows.map(row=>row.match_id)).size,rows.length,'duplicate_response_map');
   if(matchId)assert.equal(rows[0].match_id,matchId,'detail_id_mismatch');
   if(kind==='global'&&current.cursor!==null)assert(rows.every(row=>BigInt(row.match_id)<BigInt(current.cursor)),'cursor_not_advancing');
  }catch{request.status='invalid_response';request.reason='INVALID_DISCOVERY_RESPONSE';continue;}
  observationCount+=rows.length;assert(observationCount<=100000,'discovery_observation_limit');
  request.status='projected';request.rows=rows.length;
  if(league)leagueResponses.set(league,{requestId:q.requestId,receivedAt:q.receivedAt,rows:rows.length});
  if(matchId)details.add(matchId);
  if(kind==='global'){
   current.pageRequestIds.push(q.requestId);
   if(rows.length){current.cursor=rows.map(row=>row.match_id).sort(cmp)[0];current.status='bounded';}
   else current.status='endpoint_end_observed';
  }
  for(const row of rows){
   const list=observations.get(row.match_id)??[];
   list.push({row,requestId:q.requestId,endpoint:q.endpoint,endpointLeagueId:league,receivedAt:q.receivedAt,bodySha256:q.bodySha256,receiptSha256:q.receiptSha256});
   observations.set(row.match_id,list);
   if((league!==null||row.leagueid===null||leagues.has(row.leagueid))&&inWindow(row.start_time)!==false)possible.add(row.match_id);
   if(excludedMaps.has(row.match_id)&&row.series_id)contaminated.add(seriesKey(row.series_id));
  }
 }
 const targetSeries=new Set();for(const [id,list] of observations)if(possible.has(id))for(const o of list)if(o.row.series_id)targetSeries.add(o.row.series_id);
 const maps=[...observations].sort(([a],[b])=>cmp(a,b)).map(([matchId,list])=>{
  const metadata={},reasons=new Set();
  for(const field of fields){const values=[...new Set(list.map(o=>o.row[field]).filter(value=>value!==null))];
   metadata[field]=values.length===1?values[0]:null;if(values.length>1)reasons.add('METADATA_CONFLICT');}
  if(list.some(o=>o.endpointLeagueId&&o.row.leagueid!==null&&o.endpointLeagueId!==o.row.leagueid))reasons.add('LEAGUE_ENDPOINT_CONFLICT');
  if(metadata.start_time===null)reasons.add('START_UNKNOWN');else if(!inWindow(metadata.start_time))reasons.add('OUTSIDE_WINDOW');
  if(list.some(o=>o.row.start_time!==null&&iso(o.row.start_time*1000)>o.receivedAt))reasons.add('START_AFTER_OBSERVATION');
  if(metadata.leagueid===null)reasons.add('EVENT_SCOPE_UNKNOWN');else if(!leagues.has(metadata.leagueid))reasons.add('FOREIGN_EVENT');
  if(metadata.series_id===null)reasons.add('SERIES_UNKNOWN');
  if(excludedMaps.has(matchId)||list.some(o=>o.row.series_id&&contaminated.has(seriesKey(o.row.series_id))))reasons.add('EXPOSED_MAP_OR_SERIES');
  if(!details.has(matchId))reasons.add('DETAIL_NOT_CAPTURED');
  return {matchId,metadata,startedAt:metadata.start_time===null?null:iso(metadata.start_time*1000),possibleTarget:possible.has(matchId),
   targetSeriesSibling:list.some(o=>o.row.series_id&&targetSeries.has(o.row.series_id)),detailCaptured:details.has(matchId),
   observations:list,reasons:[...reasons].sort(),eligibleForScoring:false};
 });
 const unresolved=new Set();for(const m of maps)if(m.reasons.some(code=>code!=='DETAIL_NOT_CAPTURED'))
  for(const o of m.observations)if(o.row.series_id)unresolved.add(o.row.series_id);
 for(const m of maps)if(m.observations.some(o=>o.row.series_id&&unresolved.has(o.row.series_id)))m.reasons=[...m.reasons,'SERIES_MEMBER_UNRESOLVED'].sort();
 const reasons=new Set([...state.reasons,'DENOMINATOR_REQUIRES_REVIEWED_EVENT_REGISTER','DETAIL_CAPTURE_IS_NOT_PRO_VERIFICATION']);
 if([...leagues].some(id=>!leagueResponses.has(id)))reasons.add('LEAGUE_RESPONSE_MISSING');
 if(current?.status!=='endpoint_end_observed')reasons.add('GLOBAL_SCAN_INCOMPLETE');
 if(state.snapshotAt<plan.window.until)reasons.add('TARGET_WINDOW_NOT_FINISHED');
 if(possible.size>plan.collection.maxTargetMaps)reasons.add('TARGET_BUDGET_EXCEEDED');
 if(requests.some(q=>q.status==='invalid_response'))reasons.add('INVALID_DISCOVERY_RESPONSE');
 if(requests.some(q=>q.status==='outcome_unknown'))reasons.add('UNKNOWN_REQUEST_OUTCOME_REQUIRES_REVIEW');
 const stops=[...state.reasons,'TARGET_BUDGET_EXCEEDED','INVALID_DISCOVERY_RESPONSE','UNKNOWN_REQUEST_OUTCOME_REQUIRES_REVIEW'];
 let nextRequest=null;
 if(!stops.some(code=>reasons.has(code))){
  const league=plan.scope.find(s=>!leagueResponses.has(s.leagueId));
  const missing=maps.find(m=>m.possibleTarget&&!m.detailCaptured&&!m.reasons.some(code=>['EXPOSED_MAP_OR_SERIES','METADATA_CONFLICT','LEAGUE_ENDPOINT_CONFLICT','FOREIGN_EVENT','OUTSIDE_WINDOW','START_AFTER_OBSERVATION'].includes(code)));
  const endpoint=league?'/leagues/'+league.leagueId+'/matches':missing?'/matches/'+missing.matchId:
   current?.status==='endpoint_end_observed'?null:current?.cursor?'/proMatches?less_than_match_id='+current.cursor:'/proMatches';
  if(endpoint)nextRequest={endpoint,advisoryOnly:true};
 }
 const body={format:'conditional-collection-v2-discovery-report-v1',registrationId:r.id,registrationSha256:r.packageSha256,
  journalHeadSha256:state.headSha256,snapshotAt:state.snapshotAt,syntheticOnly:evidence.header.synthetic_only,
  bindingBasis:'validated_supplied_registration_journal_and_response_bytes_not_database_attestation',
  scope:plan.scope,window:plan.window,exposureSnapshotSha256:plan.exposureSnapshotSha256,budget:plan.collection,attempts:state.attempts,
  leagueResponses:[...leagueResponses].map(([leagueId,response])=>({leagueId,...response})),passes,requests,maps,
  observationCount,observedPossibleMaps:possible.size,verifiedProMaps:null,denominatorComplete:false,nextRequest,reasons:[...reasons].sort(),...closed};
 return {...body,fingerprint:sha(JSON.stringify(body))};
}
export class ConditionalCollectionV2Discovery{
 constructor(db){this.db=db;this.journal=new ConditionalCollectionV2Journal(db);}
 async read(ownerId,id){
  const registration=await this.journal.registration(ownerId,id),p=parse(registration.packageText);
  for(const path of collectionV2DiscoveryPaths)assert.equal(sha(await readFile(path)),p.executable.code[path],'registered_v2_discovery_code_changed');
  const before=await this.journal.read(ownerId,id); // Existing full archive verification, including orphan bodies and entry chains.
  return this.journal.transaction(ownerId,registration,async tx=>{
   const header=(await sql`SELECT * FROM conditional_collection_v2_journals WHERE registration_id=${id}::uuid`.execute(tx)).rows[0];
   const events=(await sql`SELECT * FROM conditional_collection_v2_events WHERE registration_id=${id}::uuid ORDER BY sequence`.execute(tx)).rows;
   assert.equal(events.at(-1)?.head_sha256??header.header_sha256,before.headSha256,'discovery_snapshot_changed_retry');
   const totals=(await sql`SELECT
    (SELECT count(*)::int FROM conditional_blob_receipts WHERE registration_id=${id}::uuid) AS receipts,
    (SELECT count(*)::int FROM conditional_blob_entries WHERE registration_id=${id}::uuid) AS entries,
    (SELECT coalesce(sum(byte_length),0)::text FROM conditional_raw_blobs WHERE registration_id=${id}::uuid) AS bytes`.execute(tx)).rows[0];
   assert(totals.receipts===before.archive.receipts&&totals.entries===before.archive.entries&&Number(totals.bytes)===before.archive.uniqueBytes,
    'discovery_snapshot_changed_retry');
   const snapshotAt=iso((await sql`SELECT conditional_collection_clock() AS at`.execute(tx)).rows[0].at);
   const report=await replayCollectionV2Discovery({registration,header,events,snapshotAt},async q=>{
    const row=(await sql`SELECT r.metadata_text,b.body FROM conditional_blob_receipts r JOIN conditional_raw_blobs b
     ON b.registration_id=r.registration_id AND b.body_sha256=r.body_sha256 WHERE r.registration_id=${id}::uuid AND r.request_id=${q.requestId}::uuid`.execute(tx)).rows[0];
    assert(row,'discovery_archive_response_missing');return {metadataText:row.metadata_text,bytes:row.body};
   });
   return {report,databaseVerification:{journalHeadSha256:before.headSha256,archiveVerified:true,activeOwnerChecked:true},...closed};
  });
 }
}
