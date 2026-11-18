/** Normalized exclusion evidence; never training eligibility or raw-byte attestation. */
import assert from 'node:assert/strict';
import {sha,id,buildExposureLedger} from './exposure-ledger-core.mjs';
const decimal=v=>typeof v==='number'?(assert(Number.isSafeInteger(v),'unsafe_id'),id(String(v))):id(v);
const hash=v=>assert(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'invalid_sha');
const time=v=>assert(typeof v==='string'&&Number.isFinite(Date.parse(v)),'invalid_clock');
const key=v=>JSON.stringify(['opendota',decimal(v)]);
function source(s){assert.equal(s.provider,'opendota','provider');hash(s.payloadSha256);time(s.fetchedAt);
 if(s.knownAt!=null)time(s.knownAt);}
export function detailSeriesProjection(x){
 assert.equal(x.status,'observed','observation_status');id(x.matchId);
 const r=x.receipt;assert.equal(r.originalResponseBytesRetained,false,'projection_basis');
 assert(['validated_http_projected','normalized_local_receipt'].includes(r.basis),'projection_basis');
 assert.deepEqual(r.sourceIssues,[],'source_issues');source(r.source);hash(r.projectionSha256);
 assert.equal(sha(JSON.stringify(r.projection)),r.projectionSha256,'projection_sha');
 assert.equal(r.source.endpoint,'/matches/'+x.matchId,'endpoint');
 assert.equal(decimal(r.projection.match_id),x.matchId,'map_binding');
 assert(r.projection.syntheticOnly!==true&&r.projection.synthetic!==true&&!('_fixture' in r.projection),'synthetic');
 return {row:{matchId:x.matchId,seriesKey:key(r.projection.series_id),localSeriesId:null},
  provenance:{basis:'verified_normalized_detail_projection_not_raw',source:r.source,projectionSha256:r.projectionSha256,
   originalResponseBytesRetained:false,trainingEligibilityEstablished:false}};
}
export function leagueLastSeriesProjection(x){
 assert(Array.isArray(x.leagues)&&x.leagues.length<=1000,'league_shape');
 const rows=x.leagues.filter(l=>String(l.leagueId)==='20486');assert.equal(rows.length,1,'league_selection');
 const l=rows[0];source(l.source);assert.equal(l.source.endpoint,'/leagues/20486/matches','league_endpoint');
 assert.equal(decimal(l.last.leagueid),'20486','league_binding');
 return {row:{matchId:decimal(l.last.match_id),seriesKey:key(l.last.series_id),localSeriesId:null},
  provenance:{basis:'archived_normalized_league_last_row_not_raw',source:l.source,projectionSha256:null,
   originalResponseBytesRetained:false,trainingEligibilityEstablished:false}};
}

/** Recover only the five namespace-only sources, then demand exact baseline reproduction. */
export function restoreBaselineSources(ledger,inherited){
 const paths=new Set(inherited.map(s=>s.path));assert.equal(paths.size,inherited.length,'duplicate_parent_source');
 const inheritedMaps=new Set(inherited.flatMap(s=>s.rows.map(r=>r.matchId))),sources=[...inherited];
 for(const s of ledger.sources.filter(s=>!paths.has(s.path))){
  const rows=[];
  for(const m of ledger.maps)for(const e of m.evidence.filter(e=>e.source===s.path)){
   assert(!inheritedMaps.has(m.matchId)&&m.seriesKeys.length<=1&&m.localSeriesIds.length===0,'ambiguous_parent_row');
   assert(Number.isSafeInteger(e.row)&&e.row>=0&&e.row<s.rows&&!rows[e.row],'invalid_parent_row');
   rows[e.row]={matchId:m.matchId,seriesKey:m.seriesKeys[0]??null,localSeriesId:null};
  }
  assert.equal(rows.filter(Boolean).length,s.rows,'missing_parent_rows');
  sources.push({...s,rows,standaloneSeriesKeys:[]});
 }
 const replay=buildExposureLedger({format:'exposure-ledger-input-v1',capturedAt:ledger.capturedAt,sources,pendingReview:ledger.pendingReview});
 assert.deepEqual(replay,ledger,'parent_reconstruction');return sources;
}
export function extendSeries(ledger,sources,observations,expectedSeriesIds,capturedAt){
 assert.equal(new Set(expectedSeriesIds).size,expectedSeriesIds.length,'duplicate_queue');expectedSeriesIds.forEach(id);
 const queue=new Set(expectedSeriesIds.map(key)),mapIds=new Set(ledger.mapIds),decisions=[];
 const additions=[];
 for(const o of observations){
  assert(mapIds.has(o.row.matchId),'unreviewed_map');assert(queue.has(o.row.seriesKey),'outside_series_queue');hash(o.sha256);
  const known=ledger.maps.find(m=>m.matchId===o.row.matchId).seriesKeys;
  decisions.push({path:o.path,sha256:o.sha256,matchId:o.row.matchId,seriesKey:o.row.seriesKey,
   status:known.length&&known.some(k=>k!==o.row.seriesKey)?'conflicting_evidence_preserved':'exclusion_binding',provenance:o.provenance});
  additions.push({path:o.path+'#series-projection',sha256:o.sha256,adapter:o.provenance.basis,rows:[o.row],standaloneSeriesKeys:[]});
 }
 assert.deepEqual([...new Set(observations.map(o=>o.row.seriesKey))].sort(),[...queue].sort(),'incomplete_series_queue');
 const input={format:'exposure-ledger-input-v1',capturedAt,sources:[...sources,...additions],
  pendingReview:['Remaining opaque/archive coverage and Valve/OpenDota links are separate; global completeness not certified']};
 const extended=buildExposureLedger(input);assert.deepEqual(extended.mapIds,ledger.mapIds,'map_inventory_changed');
 return {input,ledger:extended,decisions,queueComplete:true,completeGlobalInventory:false,
  registrationAllowed:false,collectionAllowed:false,deployable:false};
}
