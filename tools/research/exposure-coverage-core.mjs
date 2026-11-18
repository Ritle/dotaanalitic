/** Scoped exclusion audit only. Does not merge identities or admit a model. */
import assert from 'node:assert/strict';
import {id,seriesKey} from './exposure-ledger-core.mjs';
import {reviewArchive} from './exposure-archive-core.mjs';

export function decodeArchive(bytes){
 assert(Buffer.isBuffer(bytes)&&bytes.length<=128*1024**2,'file_limit');
 let encoding='utf8',text;
 if(bytes[0]===255&&bytes[1]===254){assert(bytes.length%2===0,'invalid_utf16');encoding='utf16le';text=bytes.subarray(2).toString('utf16le');}
 else if(bytes[0]===254&&bytes[1]===255){assert(bytes.length%2===0,'invalid_utf16');encoding='utf16be';text=Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');}
 else text=bytes.toString('utf8').replace(/^\uFEFF/,'');
 if(text.trim()==='Unauthorized')return {encoding,kind:'authorization_error_no_payload',value:null};
 try{return {encoding,kind:'json',value:JSON.parse(text)};}
 catch(e){if(!(e instanceof SyntaxError))throw e;return {encoding,kind:'unparsed',value:null};}
}

export function auditValveSeries(evidence,ledger){
 const maps=new Map(ledger.maps.map(m=>[id(m.matchId),m.seriesKeys.map(seriesKey)]));
 assert.equal(maps.size,ledger.maps.length,'duplicate_map');
 const groups=evidence.map(v=>{
  assert.equal(v.provider,'valve');id(v.providerSeriesId);
  assert(Array.isArray(v.mapIds)&&new Set(v.mapIds).size===v.mapIds.length,'duplicate_valve_map');
  const members=v.mapIds.map(n=>({matchId:id(n),present:maps.has(n),seriesKeys:maps.get(n)??[]}));
  const keys=[...new Set(members.flatMap(m=>m.seriesKeys))].sort();
  const status=keys.length>1?'conflicting_map_evidence':keys.length===0?'no_opendota_link':
   members.every(m=>m.present&&m.seriesKeys.length===1)?'all_maps_agree':'partial_map_agreement';
  return {...v,status,observedOpenDotaKeys:keys,members,canonicalAliasEstablished:false};
 });
 const reverse=new Map();
 for(const g of groups)for(const k of g.observedOpenDotaKeys){
  if(!reverse.has(k))reverse.set(k,new Set());reverse.get(k).add(g.providerSeriesId);
 }
 const reverseConflicts=[...reverse].filter(([,ids])=>ids.size>1).map(([key,ids])=>({key,valveSeriesIds:[...ids].sort()}));
 const counts={};for(const g of groups)counts[g.status]=(counts[g.status]??0)+1;
 return {groups,counts,reverseConflicts,canonicalAliasesCreated:0,
  unknownOpenDotaMapIds:ledger.maps.filter(m=>m.seriesKeys.length===0).map(m=>m.matchId),
  missingValveMapIds:[...new Set(groups.flatMap(g=>g.members.filter(m=>!m.present).map(m=>m.matchId)))].sort()};
}

export function auditCoverageFile(bytes,ledger,triage,namespace,{maxNodes=12000000}={}){
 const decoded=decodeArchive(bytes);
 if(decoded.kind!=='json')return {encoding:decoded.encoding,status:decoded.kind,
  unresolvedReferences:[],opaque:[],referenceCounts:{},scannedNodes:0};
 let review;
 try{review=reviewArchive(decoded.value,ledger,{maxNodes,maxDepth:64});}
 catch(e){if(!['archive_node_limit','archive_depth_limit','embedded_byte_limit'].some(k=>e.message.includes(k)))throw e;
  return {encoding:decoded.encoding,status:'resource_limit',unresolvedReferences:[],opaque:[],referenceCounts:{},scannedNodes:0};}
 const decisions=new Map(namespace.decisions.map(d=>[d.value,d.namespace]));
 const prior=new Map(triage.decisions.map(d=>[d.matchId,d.status]));
 const unresolvedReferences=[],referenceCounts={};
 for(const r of review.references){
  let status=r.status;
  if(status.startsWith('novel_')&&r.kind==='map'){
   const ns=decisions.get(r.value);
   if(ns==='pandascore_match'&&r.provider==null)status='pandascore_reference';
   else if(prior.get(r.value)==='native_ranked_evidence')status='ranked_reference_not_pro';
   // Synthetic validity belongs to the containing input, not a coincident number.
  }
  referenceCounts[status]=(referenceCounts[status]??0)+1;
  if(status.startsWith('novel_'))unresolvedReferences.push(r);
 }
 // Numeric coverage is conservative exclusion only, never a series alias assertion.
 return {encoding:decoded.encoding,status:unresolvedReferences.length||review.opaque.length?'requires_review':'scoped_references_accounted',
  referenceCounts,unresolvedReferences,opaque:review.opaque,scannedNodes:review.summary.nodes,
  syntheticPaths:review.syntheticPaths,unknownTextIsNotEvidenceOfAbsence:true};
}
