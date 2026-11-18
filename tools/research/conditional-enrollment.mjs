/** Offline enrollment audit. A reviewed local register is a trust boundary, not an API signature. */
import assert from 'node:assert/strict';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {EvaluationDiscoveryEntrySchema,EvaluationDiscoveryRowsSchema} from '../../packages/contracts/dist/index.js';
import {inspectConditionalSources,sourceSha} from './conditional-future-source-binding.mjs';
import {conditionalDigest} from '../../.tools/s304-future-runtime/conditional-future-holdout.mjs';
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n),Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Time=z.string().datetime({precision:3}),Text=z.string().min(1).max(512);
const Series=z.object({nativeSeriesId:Id,state:z.enum(['finished','cancelled','postponed','scheduled']),mapIds:z.array(Id).max(100),completedAt:Time.nullable()}).strict();
const Register=z.object({format:z.literal('reviewed-native-event-register-v1'),editionKey:Text,leagueId:Id,
 stage:z.enum(['main_event','qualifier','division2']),closed:z.boolean(),series:z.array(Series).max(500)}).strict();
export const EnrollmentInputSchema=z.object({format:z.literal('conditional-enrollment-input-v1'),syntheticOnly:z.boolean(),snapshotAt:Time,
 window:z.object({fromAt:Time,until:Time}).strict(),scope:z.array(z.object({editionKey:Text,leagueId:Id}).strict()).min(1).max(10),
 pages:z.array(EvaluationDiscoveryEntrySchema).max(200),registers:z.array(z.object({reviewedAt:Time,evidenceRef:Text,bodySha256:Sha,rawBody:z.string().max(8388608)}).strict()).max(10),
 preparedTargetIds:z.array(Id).max(5000),exposure:z.object({mapIds:z.array(Id).max(100000),seriesKeys:z.array(Text).max(100000)}).strict()}).strict();
const cmp=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const unique=(v,why)=>assert.equal(new Set(v).size,v.length,why);
const key=id=>JSON.stringify(['opendota',id]);
const iso=start=>start===null?null:new Date(start*1000).toISOString();

export function verifyConditionalEnrollment(raw,rawArchive){
 const input=EnrollmentInputSchema.parse(raw),{archive,rows:sourceRows}=inspectConditionalSources(rawArchive),problems=new Set(),warnings=new Set();
 assert.equal(input.syntheticOnly,archive.syntheticOnly,'synthetic_input_mismatch');
 assert(input.window.fromAt<input.window.until,'invalid_window');assert(archive.recordedAt<=input.snapshotAt,'archive_after_snapshot');
 for(const values of [input.scope.map(s=>s.leagueId),input.scope.map(s=>s.editionKey),input.preparedTargetIds,input.exposure.mapIds,input.exposure.seriesKeys])unique(values,'duplicate_scope');
 if(input.snapshotAt<input.window.until)problems.add('WINDOW_NOT_FINISHED');
 const leagues=new Set(input.scope.map(s=>s.leagueId)),observations=new Map(),endpointMaps=new Map(),pageReceipts=[];
 const observe=(row,origin)=>{const list=observations.get(row.match_id)??[];list.push({row,origin});observations.set(row.match_id,list);};
 let cursor=null,proStarted=false,proTerminal=false,proFailed=false,proPages=0,lastFetch=null;
 for(const [i,entry] of input.pages.entries()){
  assert.equal(entry.sequence,i,'page_sequence_gap');const at=entry.status==='captured'?entry.fetchedAt:entry.failedAt;
  assert(at<=input.snapshotAt&&(!lastFetch||at>=lastFetch),'page_clock_invalid');lastFetch=at;
  const league=/^\/leagues\/([1-9]\d*)\/matches$/.exec(entry.endpoint)?.[1]??null;
  if(!league){assert(!proTerminal,'page_after_terminal');assert.equal(entry.endpoint,proStarted?'/proMatches?less_than_match_id='+cursor:'/proMatches','pro_cursor_mismatch');proStarted=true;proPages++;}
  let rows=[];
  if(entry.status==='captured'){
   assert.equal(sourceSha(entry.rawBody),entry.payloadSha256,'page_bytes_changed');rows=EvaluationDiscoveryRowsSchema.parse(JSON.parse(entry.rawBody));
   unique(rows.map(r=>r.match_id),'duplicate_page_map');
   if(!league){if(cursor!==null)assert(rows.every(r=>BigInt(r.match_id)<BigInt(cursor)),'pro_cursor_not_advancing');
    if(!rows.length)proTerminal=true;else cursor=rows.map(r=>r.match_id).sort(cmp)[0];}
  }else {problems.add('DISCOVERY_REQUEST_FAILED');if(!league){proTerminal=true;proFailed=true;}}
  if(league&&leagues.has(league)){
   const ids=endpointMaps.get(league)??new Set();for(const r of rows)ids.add(r.match_id);
   if(entry.status==='captured')endpointMaps.set(league,ids);
   if(at<input.window.until)warnings.add('RETAINED_PAGES_PREDATE_WINDOW_END');
  }
  for(const r of rows)observe(r,{kind:'page',league,sequence:i});
  pageReceipts.push({sequence:i,endpoint:entry.endpoint,status:entry.status,observedAt:at,sha256:entry.status==='captured'?entry.payloadSha256:null});
 }
 const source=new Map(sourceRows.map(r=>[r.matchId,r]));
 for(const r of sourceRows){const data=EvaluationDiscoveryRowsSchema.parse([JSON.parse(r.receipt.rawBody)])[0];observe(data,{kind:'detail',league:null});}
 const registers=input.registers.map(e=>{
  assert.equal(sourceSha(e.rawBody),e.bodySha256,'register_bytes_changed');assert(e.reviewedAt<=input.snapshotAt,'review_after_snapshot');
  const register=Register.parse(JSON.parse(e.rawBody));
  return {register,reviewedAt:e.reviewedAt,evidenceRef:e.evidenceRef,sha256:e.bodySha256};
 });
 unique(registers.map(r=>r.register.leagueId),'duplicate_event_register');
 const registered=new Map(),series=[];
 for(const selected of input.scope){
  const record=registers.find(r=>r.register.leagueId===selected.leagueId);
  if(!endpointMaps.has(selected.leagueId))problems.add('LEAGUE_RESPONSE_MISSING');
  if(!record){problems.add('EVENT_REGISTER_MISSING');continue;}
  const r=record.register;
  if(r.editionKey!==selected.editionKey||r.stage!=='main_event')problems.add('EVENT_EDITION_MISMATCH');
  if(!r.closed)problems.add('EVENT_REGISTER_NOT_CLOSED');
  unique(r.series.map(s=>s.nativeSeriesId),'duplicate_native_series');
  for(const s of r.series){
   unique(s.mapIds,'duplicate_series_map');
   const seriesKey=key(s.nativeSeriesId),reasons=[];
   if(s.state==='scheduled')reasons.push('SERIES_NOT_CLOSED');
   if(s.completedAt!==null&&s.completedAt>record.reviewedAt)reasons.push('REGISTER_COMPLETION_AFTER_REVIEW');
   if(s.state==='finished'&&(!s.mapIds.length||s.completedAt===null))reasons.push('SERIES_COMPLETION_UNKNOWN');
   if(['cancelled','postponed'].includes(s.state)&&s.mapIds.length)reasons.push('ADMINISTRATIVE_SERIES_HAS_MAPS');
   for(const id of s.mapIds){assert(!registered.has(id),'map_in_multiple_series');registered.set(id,{seriesKey,leagueId:selected.leagueId});}
   series.push({...s,seriesKey,leagueId:selected.leagueId,reasons});
  }
 }
 if(registers.some(r=>!leagues.has(r.register.leagueId)))problems.add('FOREIGN_EVENT_REGISTER');
 unique(series.map(s=>s.seriesKey),'native_series_cross_event_conflict');
 const ids=new Set([...registered.keys(),...input.preparedTargetIds]);
 for(const [id,variants] of observations){
  if(variants.some(({row:r,origin})=>origin.league&&leagues.has(origin.league)||
   ((r.leagueid===null||leagues.has(r.leagueid))&&(r.start_time===null||(iso(r.start_time)>=input.window.fromAt&&iso(r.start_time)<input.window.until)))))ids.add(id);
 }
 // Keep outside-window siblings of any target series, even if absent from the register.
 const relevantSeries=new Set(series.map(s=>s.nativeSeriesId));
 for(const id of ids)for(const v of observations.get(id)??[])if(v.row.series_id)relevantSeries.add(v.row.series_id);
 for(const [id,variants] of observations)if(variants.some(v=>v.row.series_id&&relevantSeries.has(v.row.series_id)))ids.add(id);
 const rows=[...ids].sort(cmp).map(matchId=>{
  const variants=observations.get(matchId)??[],reg=registered.get(matchId),reasons=[],metadata={};
  for(const name of ['start_time','leagueid','series_id','radiant_team_id','dire_team_id']){
   const values=[...new Set(variants.map(v=>v.row[name]).filter(v=>v!==null))];
   metadata[name]=values.length===1?values[0]:null;if(values.length>1)reasons.push('METADATA_CONFLICT');
  }
  if(variants.some(v=>v.origin.league&&v.row.leagueid!==null&&v.row.leagueid!==v.origin.league))reasons.push('LEAGUE_ENDPOINT_CONFLICT');
  const startedAt=iso(metadata.start_time),inWindow=startedAt===null?null:startedAt>=input.window.fromAt&&startedAt<input.window.until;
  const eventKnown=metadata.leagueid!==null&&leagues.has(metadata.leagueid),possible=!!reg||variants.some(v=>v.origin.league&&leagues.has(v.origin.league))||metadata.leagueid===null||eventKnown;
  const denominatorCandidate=possible&&inWindow!==false;
  if(!reg&&possible)reasons.push('UNREGISTERED_OBSERVED_MAP');
  if(reg&&(metadata.leagueid!==null&&metadata.leagueid!==reg.leagueId||metadata.series_id!==null&&key(metadata.series_id)!==reg.seriesKey))reasons.push('REGISTER_SOURCE_MISMATCH');
  if(reg&&!endpointMaps.get(reg.leagueId)?.has(matchId))reasons.push('MAP_MISSING_FROM_LEAGUE_RESPONSE');
  const fact=source.get(matchId),verified=!!fact?.target&&fact.label!==null;
  if(!verified)reasons.push('MAP_SOURCE_UNVERIFIED');
  if(startedAt===null)reasons.push('START_UNKNOWN');if(metadata.series_id===null)reasons.push('SERIES_UNKNOWN');
  if(!eventKnown)reasons.push('EVENT_SCOPE_UNKNOWN_OR_FOREIGN');
  const prepared=input.preparedTargetIds.includes(matchId);
  if(denominatorCandidate&&!prepared)reasons.push('FEATURE_INPUT_MISSING');
  const seriesKey=reg?.seriesKey??(metadata.series_id?key(metadata.series_id):null);
  if(input.exposure.mapIds.includes(matchId)||seriesKey&&input.exposure.seriesKeys.includes(seriesKey))reasons.push('EXPOSED_MAP_OR_SERIES');
  return {matchId,seriesKey,metadata,startedAt,inWindow,denominatorCandidate,verifiedProMap:verified&&eventKnown&&inWindow===true,
   prepared,completedAt:fact?.label?new Date(Number(BigInt(fact.label.completedAtUs)/1000n)).toISOString():null,
   reasons:[...new Set(reasons)].sort(),eligible:false};
 });
 const byId=new Map(rows.map(r=>[r.matchId,r]));
 for(const s of series){
  const members=s.mapIds.map(id=>byId.get(id));
  if(members.some(r=>r.inWindow!==true))s.reasons.push('SERIES_OUTSIDE_WINDOW');
  if(s.completedAt!==null&&s.completedAt>=input.window.until)s.reasons.push('SERIES_OUTSIDE_WINDOW');
  if(s.completedAt!==null&&members.some(r=>r.completedAt&&r.completedAt>s.completedAt))s.reasons.push('SERIES_COMPLETION_CONFLICT');
  if(rows.some(r=>r.metadata.series_id===s.nativeSeriesId&&!s.mapIds.includes(r.matchId)))s.reasons.push('SERIES_UNLISTED_MEMBER');
  if(members.some(r=>r.reasons.length))s.reasons.push('SERIES_HAS_UNAVAILABLE_MEMBER');
  if(s.reasons.some(r=>['SERIES_NOT_CLOSED','SERIES_COMPLETION_UNKNOWN','ADMINISTRATIVE_SERIES_HAS_MAPS','SERIES_UNLISTED_MEMBER','SERIES_COMPLETION_CONFLICT','REGISTER_COMPLETION_AFTER_REVIEW'].includes(r)))
   for(const reason of s.reasons)if(reason!=='SERIES_HAS_UNAVAILABLE_MEMBER')problems.add(reason);
  s.reasons=[...new Set(s.reasons)].sort();
 }
 const completenessReasons=new Set(['METADATA_CONFLICT','LEAGUE_ENDPOINT_CONFLICT','UNREGISTERED_OBSERVED_MAP','REGISTER_SOURCE_MISMATCH',
  'MAP_MISSING_FROM_LEAGUE_RESPONSE','MAP_SOURCE_UNVERIFIED','START_UNKNOWN','SERIES_UNKNOWN','EVENT_SCOPE_UNKNOWN_OR_FOREIGN']);
 for(const r of rows)if(r.denominatorCandidate)for(const reason of r.reasons)if(completenessReasons.has(reason))problems.add(reason);
 const complete=problems.size===0;
 for(const r of rows){const s=series.find(s=>s.seriesKey===r.seriesKey);
  r.eligible=complete&&r.verifiedProMap&&r.reasons.length===0&&!!s&&s.reasons.length===0;
  if(r.denominatorCandidate&&s?.reasons.length)r.reasons=[...new Set([...r.reasons,...s.reasons])].sort();
 }
 const denominator=rows.filter(r=>r.verifiedProMap).length,eligible=rows.filter(r=>r.eligible).length;
 const body={format:'conditional-enrollment-verification-v1',syntheticOnly:input.syntheticOnly,status:complete?'reviewed_inventory_consistent':'insufficient',
  basis:'reviewed_local_event_register_cross_checked_with_retained_sources',window:input.window,snapshotAt:input.snapshotAt,
  trace:{proPages:proPages===0?'not_requested':proFailed?'failed':proTerminal?'exhausted':'bounded',proPageCount:proPages,receipts:pageReceipts},
  registers:registers.map(r=>({leagueId:r.register.leagueId,editionKey:r.register.editionKey,reviewedAt:r.reviewedAt,evidenceRef:r.evidenceRef,sha256:r.sha256})),
  reasons:[...problems].sort(),warnings:[...warnings].sort(),knownPossibleMaps:rows.filter(r=>r.denominatorCandidate).length,verifiedProDenominator:denominator,
  denominatorComplete:complete,eligibleMaps:eligible,eligibleCoverage:complete&&denominator?eligible/denominator:null,rows,series,
  administrativeSeries:series.filter(s=>['cancelled','postponed'].includes(s.state)&&s.mapIds.length===0).length,
  providerCompletenessIndependentlyProven:false,independentTest:false,registrationAllowed:false,collectionAllowed:false,scoringPerformed:false,deployable:false};
 return {...body,fingerprint:conditionalDigest(body)};
}
