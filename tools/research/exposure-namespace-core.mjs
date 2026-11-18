/** Resolve archived references; no outcome/model eligibility or cross-provider series guess. */
import assert from 'node:assert/strict';
import {id,sha,buildExposureLedger} from './exposure-ledger-core.mjs';
const dec=v=>typeof v==='number'?(assert(Number.isSafeInteger(v),'unsafe_id'),id(String(v))):id(v);
const hash=x=>assert(typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),'invalid_sha');
const time=x=>assert(typeof x==='string'&&Number.isFinite(Date.parse(x)),'invalid_clock');
const key=n=>JSON.stringify(['opendota',dec(n)]);
const row=(n,s=null)=>({matchId:dec(n),seriesKey:s,localSeriesId:null});
const unique=rs=>{
 const m=new Map();for(const r of rs){if(m.has(r.matchId))assert.equal(m.get(r.matchId).seriesKey,r.seriesKey,'conflicting_source_series');else m.set(r.matchId,r);}
 return [...m.values()].sort((a,b)=>BigInt(a.matchId)<BigInt(b.matchId)?-1:1);
};
export function valveProjection(bytes,receipt,path){
 assert.equal(receipt.file,path,'valve_path');hash(receipt.sha256);assert.equal(sha(bytes),receipt.sha256,'valve_sha');
 const u=new URL(receipt.url);
 assert.equal(u.origin,'https://www.dota2.com');assert.equal(u.pathname,'/webapi/IDOTA2League/GetLeagueData/v001','valve_endpoint');
 const x=JSON.parse(bytes.toString('utf8'));assert.equal(dec(x.info.league_id),u.searchParams.get('league_id'),'valve_league');
 time(receipt.fetchedAt??receipt.savedAt);if(receipt.status!==undefined)assert.equal(receipt.status,200);
 assert(Array.isArray(x.series_infos)&&x.series_infos.length<=10000,'series_limit');
 const rows=[],valveSeries=[];
 for(const s of x.series_infos){
  assert(Array.isArray(s.match_ids)&&s.match_ids.length<=100,'map_list');
  const maps=[...new Set(s.match_ids.filter(n=>n!==0&&n!=='0').map(dec))];
  rows.push(...maps.map(n=>row(n)));valveSeries.push({provider:'valve',providerSeriesId:dec(s.series_id),mapIds:maps});
 }
 return {basis:'sha_bound_official_valve_native_maps',rows:unique(rows),valveSeries};
}
export function playerDiscoveryProjection(x,producer){
 assert(producer.includes('https://api.opendota.com/api')&&producer.includes('player-history-discovery.json'),'producer_binding');
 assert(Array.isArray(x)&&x.length<=1000,'discovery_limit');
 const rows=[];
 for(const e of x){
  if(e.status!==200)continue;
  const u=new URL(e.endpoint,'https://api.opendota.com');
  assert.equal(u.origin,'https://api.opendota.com');assert.equal(u.pathname,'/players/'+dec(e.account)+'/matches','player_endpoint');
  assert.equal(u.searchParams.get('lobby_type'),'1','wrong_history_scope');hash(e.sha256);time(e.fetchedAt);
  assert(Array.isArray(e.data)&&e.data.length<=1000,'page_limit');rows.push(...e.data.map(m=>row(m.match_id)));
 }
 return {basis:'archived_opendota_player_projection_not_raw_reverified',rows:unique(rows)};
}
export function depthProjection(x,producer){
 assert.equal(x.task,'S2-01/role-owner-check/player-history-depth');
 assert(producer.includes('player_history_runs')&&producer.includes('source_audit'),'history_producer');
 assert(Array.isArray(x.live.runs)&&x.live.runs.length<=1000,'run_limit');
 const rows=[];
 for(const r of x.live.runs){
  assert.equal(r.status,'completed');assert(r.source_audit.sources.length>0,'missing_history_sources');
  assert(r.source_audit.sources.some(s=>s.endpoint.startsWith('/explorer?sql=')),'missing_explorer');
  for(const s of r.source_audit.sources){
   assert(s.endpoint.startsWith('/explorer?sql=')||['/heroes','/leagues'].includes(s.endpoint)||/^\/matches\/[1-9]\d*$/.test(s.endpoint),'history_endpoint');
   hash(s.payloadSha256);time(s.fetchedAt);}
  assert(Array.isArray(r.source_audit.discoveryRows)&&r.source_audit.discoveryRows.length<=100000,'history_limit');
  rows.push(...r.source_audit.discoveryRows.map(m=>row(m.match_id)));
 }
 return {basis:'archived_database_history_audit_not_raw_reverified',rows:unique(rows)};
}
export function leagueSummaryProjection(x){
 assert(Array.isArray(x.leagues)&&x.leagues.length<=1000,'league_limit');const rows=[];
 for(const l of x.leagues){
  assert.equal(l.source.provider,'opendota');assert.equal(l.source.endpoint,'/leagues/'+dec(l.leagueId)+'/matches');
  hash(l.source.payloadSha256);time(l.source.fetchedAt);
  if(l.first){assert.equal(dec(l.first.leagueid),dec(l.leagueId),'league_row_mismatch');
   rows.push(row(l.first.match_id,l.first.series_id&&String(l.first.series_id)!=='0'?key(l.first.series_id):null));}
 }
 return {basis:'archived_opendota_first_row_not_raw_reverified',rows:unique(rows)};
}
export function pandascoreProjection(x){
 assert.equal(x.format,'namespace-pandascore-snapshot-v1');assert.equal(x.readOnly,true);
 assert(Array.isArray(x.records)&&x.records.length<=2000,'panda_limit');const evidence=[];
 for(const r of x.records){
  assert(['primary','page'].includes(r.kind),'panda_kind');
  assert.equal(r.provider,'pandascore');hash(r.snapshot_sha256);assert.equal(sha(r.snapshot_text),r.snapshot_sha256,'panda_snapshot_sha');
  const s=JSON.parse(r.snapshot_text);
  assert.equal(s.source.provider,'pandascore');assert.equal(s.source.endpoint,r.source_endpoint,'panda_endpoint');
  assert(/^\/dota2\/matches\/upcoming\?/.test(r.source_endpoint),'panda_scope');
  assert.equal(s.source.payloadSha256,r.source_payload_sha256);hash(r.source_payload_sha256);
  assert.equal(s.source.fetchedAt,r.source_fetched_at);time(r.source_fetched_at);time(r.recorded_at);
  assert(Date.parse(r.source_fetched_at)<=Date.parse(r.recorded_at),'panda_clock');
  assert(Array.isArray(s.data)&&s.data.length<=20,'panda_page_size');
  assert.equal(new Set(s.data.map(m=>m.providerMatchId)).size,s.data.length,'duplicate_panda_match');
  for(const m of s.data)evidence.push({provider:'pandascore',providerMatchId:id(m.providerMatchId),observationKind:r.kind,
   observationId:id(r.id),snapshotSha256:r.snapshot_sha256,sourcePayloadSha256:r.source_payload_sha256,
   fetchedAt:r.source_fetched_at,recordedAt:r.recorded_at});
 }
 return evidence;
}
export function reconcileNamespaces({pending,baseline,nativeSources,pandaEvidence,capturedAt}){
 assert(Array.isArray(pending)&&pending.length<=10000);assert.equal(new Set(pending).size,pending.length);
 pending.forEach(id);const allowed=new Set(pending),native=new Map(),panda=new Map();
 for(const s of nativeSources){hash(s.sha256);
  for(const r of s.rows){id(r.matchId);if(!allowed.has(r.matchId))continue;
   if(!native.has(r.matchId))native.set(r.matchId,[]);native.get(r.matchId).push({path:s.path,sha256:s.sha256,basis:s.adapter});}}
 for(const e of pandaEvidence){id(e.providerMatchId);assert.equal(e.provider,'pandascore');hash(e.snapshotSha256);
  if(!allowed.has(e.providerMatchId))continue;if(!panda.has(e.providerMatchId))panda.set(e.providerMatchId,[]);
  panda.get(e.providerMatchId).push(e);}
 const decisions=pending.map(value=>({value,namespace:native.has(value)&&panda.has(value)?'conflict':
  native.has(value)?'dota2_native_map':panda.has(value)?'pandascore_match':'unresolved',
  nativeEvidence:native.get(value)??[],pandaEvidence:panda.get(value)??[]}));
 const nativeIds=new Set(decisions.filter(d=>d.namespace==='dota2_native_map').map(d=>d.value));
 const safeSources=nativeSources.map(s=>({...s,rows:s.rows.filter(r=>nativeIds.has(r.matchId)),standaloneSeriesKeys:[]}));
 assert(Array.isArray(baseline.sources)&&baseline.sources.length>0,'baseline_sources_required');
 const inherited=buildExposureLedger({format:'exposure-ledger-input-v1',capturedAt,sources:baseline.sources,pendingReview:[]});
 assert.deepEqual(inherited.mapIds,baseline.mapIds,'baseline_maps_changed');
 assert.deepEqual(inherited.canonicalSeriesKeys,baseline.canonicalSeriesKeys,'baseline_series_changed');
 const ledger=buildExposureLedger({format:'exposure-ledger-input-v1',capturedAt,
  sources:[...baseline.sources,...safeSources],pendingReview:['Whole-project coverage and Valve/OpenDota series alias review remain separate from reference namespace resolution']});
 const counts={};for(const d of decisions)counts[d.namespace]=(counts[d.namespace]??0)+1;
 return {format:'exposure-namespace-resolution-v1',decisions,counts,ledger,
  referenceNamespaceComplete:decisions.every(d=>!['conflict','unresolved'].includes(d.namespace)),
  completeGlobalInventory:false,registrationAllowed:false,collectionAllowed:false,deployable:false};
}
