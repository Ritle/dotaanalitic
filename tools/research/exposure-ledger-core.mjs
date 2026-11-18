/** Conservative exclusion inventory. Never an admission, training dataset or alias merger. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const numeric = (a,b) => BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const sorted = xs => [...new Set(xs)].sort();
export function id(value) {
  assert(typeof value==='string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value)<=9223372036854775807n,'invalid_decimal_id');
  return value;
}
export function seriesKey(value) {
  const pair=JSON.parse(value);
  assert(Array.isArray(pair)&&pair.length===2&&pair[0]==='opendota','unsupported_series_namespace');
  id(pair[1]);assert.equal(JSON.stringify(pair),value,'noncanonical_series_key');return value;
}
const aliasId = value => {
  if(value==null)return null;
  assert(typeof value==='string'&&value.length>0&&value.length<=128,'invalid_local_alias');return value;
};
const native = (provider,value) => provider==='opendota' && value!=null && value!=='0'
  ? JSON.stringify(['opendota',id(value)]) : null;
const row = (matchId,key=null,localSeriesId=null) => ({matchId:id(matchId),seriesKey:key===null?null:seriesKey(key),localSeriesId:aliasId(localSeriesId)});

/** Only reviewed schemas; never infer a map from a generic id, nickname or numeric coincidence. */
export function extractExposure(adapter,x) {
  assert(x && typeof x==='object','invalid_artifact');
  assert(x.syntheticOnly!==true&&x.source?.syntheticOnly!==true,'synthetic_source');
  let rows;
  if(adapter==='v1-source') {
    const formats=['research-elo-export-v1','v1-release-inventory-v1','v1-development-dataset-v1','post-draft-capture-v1'];
    assert(formats.includes(x.format),'source_format');const s=x.source??x;
    assert.equal(s.syntheticOnly,false,'missing_real_source_flag');assert(Array.isArray(s.candidates)&&Array.isArray(s.aliases),'source_shape');
    const aliases=new Map();for(const a of s.aliases){assert(!aliases.has(a.seriesId),'duplicate_local_alias');aliases.set(a.seriesId,a);}
    rows=s.candidates.map(m=>{const a=aliases.get(m.seriesId);
      // Trust the alias for this map only when the source explicitly matched it.
      return row(m.matchId,m.seriesSourceMatched===true&&a?native(a.provider,a.providerSeriesId):null,m.seriesId);});
  } else if(adapter==='post-draft-rows') {
    assert(['conditional-post-draft-dataset-v1','conditional-post-draft-r2-dataset-v1','player-hero-experiment-dataset-v1'].includes(x.format),'source_format');
    assert.equal(x.syntheticOnly,false,'missing_real_source_flag');assert(Array.isArray(x.rows),'source_shape');
    rows=x.rows.map(m=>row(m.matchId,m.seriesKey));
  } else if(adapter==='metadata') {
    assert(Array.isArray(x),'metadata_array');rows=x.map(m=>row(m.matchId,native(m.seriesProvider,m.sourceSeriesId),m.seriesId));
  } else if(adapter==='readiness') {
    assert.equal(x.format,'post-draft-validation-readiness-file-v1','source_format');
    rows=x.input.maps.map(m=>row(m.matchId,m.seriesKey));
    const present=new Set(rows.map(m=>m.matchId));
    for(const m of x.input.previousExposure.mapIds)if(!present.has(m))rows.push(row(m));
    return {rows,standaloneSeriesKeys:x.input.previousExposure.canonicalSeriesKeys.map(seriesKey)};
  } else if(adapter==='database') {
    assert.equal(x.format,'exposure-database-snapshot-v1','source_format');
    assert.equal(x.readOnly,true,'readonly_snapshot_required');
    rows=x.maps.map(m=>row(m.matchId,native(m.provider,m.providerSeriesId),m.localSeriesId));
  } else if(adapter==='opendota-discovery-ledger') {
    assert(Array.isArray(x.sources)&&x.sources.length>0&&x.sources.every(s=>s.provider==='opendota'),'discovery_namespace');
    assert(Array.isArray(x.ledger),'source_shape');rows=x.ledger.map(m=>row(m.matchId,native('opendota',m.seriesId)));
  } else if(adapter==='opendota-receipt') {
    const o=x.observation??x;assert.equal(o.source?.provider,'opendota','receipt_namespace');
    assert(typeof o.rawBody==='string'&&sha(o.rawBody)===o.source.payloadSha256,'raw_body_sha');
    const body=JSON.parse(o.rawBody),endpoint=o.source.endpoint;
    const decimal=v=>typeof v==='number'?(assert(Number.isSafeInteger(v),'unsafe_numeric_id'),id(String(v))):id(v);
    let records;
    if(/^\/matches\/[1-9]\d*$/.test(endpoint)){
      assert.equal(decimal(body.match_id),endpoint.split('/').at(-1),'detail_map_mismatch');records=[body];
    } else if(endpoint==='/proMatches'||/^\/leagues\/[1-9]\d*\/matches$/.test(endpoint)){
      assert(Array.isArray(body),'listing_array');records=body;
    } else if(typeof endpoint==='string'&&endpoint.startsWith('/explorer?')){
      assert(body.err==null&&Array.isArray(body.rows),'explorer_error');records=body.rows;
    } else throw Error('unsupported_receipt_endpoint');
    assert(records.length<=100000,'row_limit');
    const dedup=new Map();
    for(const m of records){
      const r=row(decimal(m.match_id),m.series_id==null||m.series_id===0||m.series_id==='0'?null:keyFor(m.series_id));
      const old=dedup.get(r.matchId);if(old)assert.equal(old.seriesKey,r.seriesKey,'conflicting_receipt_series');
      else dedup.set(r.matchId,r);
    }
    rows=[...dedup.values()].sort((a,b)=>numeric(a.matchId,b.matchId));
    function keyFor(v){return JSON.stringify(['opendota',decimal(v)]);}
  } else { throw Error('unknown_adapter'); }
  assert(rows.length<=100000,'row_limit');assert.equal(new Set(rows.map(m=>m.matchId)).size,rows.length,'duplicate_map_in_source');
  return {rows,standaloneSeriesKeys:[]};
}

export function buildExposureLedger(input) {
  assert.equal(input.format,'exposure-ledger-input-v1');
  assert(typeof input.capturedAt==='string'&&new Date(input.capturedAt).toISOString()===input.capturedAt,'invalid_clock');
  assert(Array.isArray(input.sources)&&input.sources.length>0&&input.sources.length<=5000,'source_limit');
  assert(input.sources.reduce((n,s)=>n+(Array.isArray(s.rows)?s.rows.length:1000001),0)<=1000000,'total_row_limit');
  assert(Array.isArray(input.pendingReview)&&input.pendingReview.every(x=>typeof x==='string'),'pending_review');
  const sourcePaths=new Set(), maps=new Map(), aliases=new Map(), series=new Map();
  function addSeries(key,path){seriesKey(key);if(!series.has(key))series.set(key,new Set());series.get(key).add(path);}
  const sources=input.sources.map(s=>{
    assert(typeof s.path==='string'&&s.path.length>0&&!sourcePaths.has(s.path),'duplicate_source');sourcePaths.add(s.path);
    assert(/^[a-f0-9]{64}$/.test(s.sha256),'invalid_source_sha');
    assert(Array.isArray(s.rows)&&s.rows.length<=100000,'row_limit');
    assert.equal(new Set(s.rows.map(m=>m.matchId)).size,s.rows.length,'duplicate_map_in_source');
    for(const [index,m] of s.rows.entries()) {
      row(m.matchId,m.seriesKey,m.localSeriesId);
      if(!maps.has(m.matchId))maps.set(m.matchId,{matchId:m.matchId,seriesKeys:new Set(),localSeriesIds:new Set(),evidence:[]});
      const map=maps.get(m.matchId);map.evidence.push({source:s.path,row:index});
      if(m.seriesKey!==null){map.seriesKeys.add(m.seriesKey);addSeries(m.seriesKey,s.path);}
      if(m.localSeriesId!==null){map.localSeriesIds.add(m.localSeriesId);
        if(!aliases.has(m.localSeriesId))aliases.set(m.localSeriesId,{localSeriesId:m.localSeriesId,mapIds:new Set(),seriesKeys:new Set()});
        const alias=aliases.get(m.localSeriesId);alias.mapIds.add(m.matchId);if(m.seriesKey!==null)alias.seriesKeys.add(m.seriesKey);
      }
    }
    for(const key of s.standaloneSeriesKeys)addSeries(key,s.path);
    return {path:s.path,sha256:s.sha256,adapter:s.adapter,rows:s.rows.length};
  });
  const mapRows=[...maps.values()].sort((a,b)=>numeric(a.matchId,b.matchId)).map(m=>({matchId:m.matchId,
    seriesKeys:sorted(m.seriesKeys),localSeriesIds:sorted(m.localSeriesIds),evidence:m.evidence.sort((a,b)=>a.source.localeCompare(b.source))}));
  const aliasRows=[...aliases.values()].sort((a,b)=>a.localSeriesId.localeCompare(b.localSeriesId)).map(a=>({localSeriesId:a.localSeriesId,
    mapIds:[...a.mapIds].sort(numeric),seriesKeys:sorted(a.seriesKeys)}));
  const unresolvedMapIds=mapRows.filter(m=>!m.seriesKeys.length).map(m=>m.matchId);
  const conflictingMapIds=mapRows.filter(m=>m.seriesKeys.length>1).map(m=>m.matchId);
  // Conflicts block both keys; they never silently merge canonical series.
  const conflictingLocalAliases=aliasRows.filter(a=>a.seriesKeys.length>1).map(a=>a.localSeriesId);
  const unresolvedLocalAliases=aliasRows.filter(a=>!a.seriesKeys.length).map(a=>a.localSeriesId);
  return {format:'exposure-ledger-v1',capturedAt:input.capturedAt,
    scope:'reviewed_local_artifacts_and_database_snapshot',semantics:'conservative_exclusion_not_training_eligibility',
    sources:sources.sort((a,b)=>a.path.localeCompare(b.path)),maps:mapRows,aliases:aliasRows,
    mapIds:mapRows.map(m=>m.matchId),canonicalSeriesKeys:sorted(series.keys()),
    standaloneSeriesEvidence:[...series].sort(([a],[b])=>a.localeCompare(b)).map(([key,paths])=>({key,sources:sorted(paths)})),
    unresolvedMapIds,conflictingMapIds,unresolvedLocalAliases,conflictingLocalAliases,
    summary:{sources:sources.length,maps:mapRows.length,knownSeries:series.size,localAliases:aliasRows.length,
      unresolvedMaps:unresolvedMapIds.length,conflictingMaps:conflictingMapIds.length,
      unresolvedAliases:unresolvedLocalAliases.length,conflictingAliases:conflictingLocalAliases.length},
    pendingReview:sorted(input.pendingReview),completeGlobalInventory:false,
    registrationAllowed:false,collectionAllowed:false,trainingPerformed:false,deployable:false};
}

/** No positive admission while project inventory is uncertified. */
export function screenExposure(ledger,candidate) {
  id(candidate.matchId);if(candidate.seriesKey!==null)seriesKey(candidate.seriesKey);
  const reasons=[];
  if(ledger.mapIds.includes(candidate.matchId))reasons.push('MAP_ALREADY_EXPOSED');
  if(candidate.seriesKey!==null&&ledger.canonicalSeriesKeys.includes(candidate.seriesKey))reasons.push('SERIES_ALREADY_EXPOSED');
  if(candidate.seriesKey===null)reasons.push('CANDIDATE_SERIES_UNKNOWN');
  if(ledger.completeGlobalInventory!==true)reasons.push('GLOBAL_EXPOSURE_INVENTORY_NOT_CERTIFIED');
  return {status:reasons.some(r=>r.endsWith('ALREADY_EXPOSED'))?'excluded':'unresolved',reasons,independent:false,admissionAllowed:false};
}
