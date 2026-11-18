/** Provenance-backed additions to an exclusion inventory, never training eligibility. */
import assert from 'node:assert/strict';
import {id,sha} from './exposure-ledger-core.mjs';
const dec=v=>typeof v==='number'?(assert(Number.isSafeInteger(v),'unsafe_id'),id(String(v))):id(v);
const hash=v=>assert(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'invalid_source_hash');
function rows(records){
 assert(Array.isArray(records)&&records.length<=100000,'records_limit');const result=new Map();
 for(const m of records){
  const matchId=dec(m.match_id),series=m.series_id==null||String(m.series_id)==='0'?null:JSON.stringify(['opendota',dec(m.series_id)]);
  const r={matchId,seriesKey:series,localSeriesId:null},old=result.get(matchId);
  if(old)assert.equal(old.seriesKey,series,'conflicting_series_in_receipt');else result.set(matchId,r);
 }
 return [...result.values()].sort((a,b)=>BigInt(a.matchId)<BigInt(b.matchId)?-1:1);
}
function rawRows(raw,source){
 assert.equal(source.provider,'opendota');hash(source.payloadSha256);
 assert(typeof raw==='string'&&sha(raw)===source.payloadSha256,'payload_sha_mismatch');
 const body=JSON.parse(raw),endpoint=source.endpoint;
 if(/^\/matches\/[1-9]\d*$/.test(endpoint)){
  assert.equal(dec(body.match_id),endpoint.split('/').at(-1),'map_endpoint_mismatch');return rows([body]);
 }
 if(endpoint==='/proMatches'||/^\/(leagues|teams)\/[1-9]\d*\/matches$/.test(endpoint))return rows(body);
 if(typeof endpoint==='string'&&endpoint.startsWith('/explorer?')){
  assert(body.err==null,'explorer_error');return rows(body.rows);
 }
 return null; // Reference/profile/ranked endpoints are not silently relabelled pro history.
}
const evidence=e=>{
 assert(e&&typeof e.endpoint==='string'&&typeof e.adapter_version==='string'&&e.adapter_version.startsWith('opendota-'),'audit_provider');
 hash(e.payload_sha256);assert(Number.isFinite(Date.parse(e.fetched_at)),'audit_clock');
};
export function archiveSourceProjections(value,{legacyDiscoveryBound=false}={}){
 const sources=[],issues=[];let visited=0;
 function add(pointer,basis,records){sources.push({pointer,basis,rows:records,standaloneSeriesKeys:[]});}
 function visit(v,pointer,depth){
  assert(++visited<=2000000&&depth<=64,'source_walk_limit');
  if(!v||typeof v!=='object')return;
  if(Array.isArray(v)){v.forEach((a,i)=>visit(a,pointer+'/'+i,depth+1));return;}
  if(v.syntheticOnly===true||v.source?.syntheticOnly===true)return;
  if(v.source?.provider==='opendota'&&typeof v.rawBody==='string'){
   try{const r=rawRows(v.rawBody,v.source);if(r!==null)add(pointer,'sha_verified_raw_opendota',r);}
   catch{issues.push({pointer,reason:'raw_receipt_rejected'});}return;
  }
  if(pointer===''&&legacyDiscoveryBound&&v.status==='captured'){
   try{assert(/^\/leagues\/[1-9]\d*\/matches$/.test(v.endpoint)||/^\/proMatches(?:\?|$)/.test(v.endpoint),'legacy_endpoint');
    const endpoint=v.endpoint.startsWith('/proMatches?')?'/proMatches':v.endpoint;
    const r=rawRows(v.rawBody,{provider:'opendota',endpoint,payloadSha256:v.payloadSha256});
    assert(r!==null);add(pointer,'manifest_bound_legacy_opendota_receipt',r);
   }catch{issues.push({pointer,reason:'legacy_receipt_rejected'});}return;
  }
  if(v.mode==='live_opendota'&&Array.isArray(v.observations)){
   try{
    const records=v.observations.map(m=>{evidence(m.source_evidence);
      assert.equal(m.source_evidence.endpoint,'/matches/'+dec(m.match_id),'audit_map_endpoint');return {match_id:m.match_id};});
    add(pointer,'observed_live_opendota_audit_report_not_raw',rows(records));
   }catch{issues.push({pointer,reason:'live_audit_rejected'});}return;
  }
  if(v.mode==='live_opendota'&&Array.isArray(v.cohorts)){
   for(const [i,c] of v.cohorts.entries())try{
    evidence(c.source_evidence);assert.equal(c.source_evidence.endpoint,'/leagues/'+dec(c.league_id)+'/matches','cohort_endpoint');
    add(pointer+'/cohorts/'+i,'observed_live_opendota_discovery_report_not_raw',rows(c.matches));
   }catch{issues.push({pointer:pointer+'/cohorts/'+i,reason:'live_cohort_rejected'});}return;
  }
  for(const [k,x] of Object.entries(v))if(x&&typeof x==='object')visit(x,pointer+'/'+k.replaceAll('~','~0').replaceAll('/','~1'),depth+1);
 }
 visit(value,'',0);return {sources,issues};
}
