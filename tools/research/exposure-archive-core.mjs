/** Reference discovery only. An untyped ID is never a new verified native map. */
import assert from 'node:assert/strict';
import {sha} from './exposure-ledger-core.mjs';
const mapKeys=new Set(['matchId','match_id','mapId','map_id','canonical_match_id','targetMatchId','target_map_id','nativeMatchId']);
const mapLists=new Set(['mapIds','matchIds','selectedMapIds','unknownSeriesMapIds','excludedMapIds','unresolvedLocalMapIds','match_ids','map_ids','selected_match_ids']);
const seriesKeys=new Set(['seriesKey','canonicalSeriesKey','providerSeriesKey']);
const seriesLists=new Set(['seriesKeys','canonicalSeriesKeys']);
const seriesIds=new Set(['seriesId','series_id','providerSeriesId','provider_series_id','sourceSeriesId']);
const decimal=v=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n
  ?v:typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):null;
const ordered=xs=>[...new Set(xs)].sort();
const pointer=s=>s.replaceAll('~','~0').replaceAll('/','~1');

export function reviewArchive(value,baseline,{maxNodes=2000000,maxDepth=64,maxEmbeddedBytes=128*1024**2}={}) {
  const knownMaps=new Set(baseline.mapIds),knownSeries=new Set(baseline.canonicalSeriesKeys);
  const localAliases=new Set(baseline.aliases.map(a=>a.localSeriesId));
  const refs=[],opaque=[],syntheticPaths=[];
  let nodes=0,embeddedBytes=0;
  function reference(kind,v,path,provider) {
    if(v==null||v===0||v==='0')return;
    if(kind==='series'&&typeof v==='string'&&localAliases.has(v)){
      refs.push({kind:'local_alias',value:v,path,status:'covered',provider:null});return;
    }
    if(kind==='series_key'){
      let key;try{const x=typeof v==='string'&&/^opendota:[1-9]\d*$/.test(v)?['opendota',v.slice(9)]:JSON.parse(v);
        if(!Array.isArray(x)||x.length!==2||x[0]!=='opendota'||decimal(x[1])!==x[1])throw Error();key=JSON.stringify(x);}catch{
        opaque.push({path,reason:'unrecognized_series_key'});return;
      }
      refs.push({kind,value:key,path,provider:'opendota',status:knownSeries.has(key)?'covered':'novel_explicit_native_series'});return;
    }
    const n=decimal(v);
    if(n===null){opaque.push({path,reason:kind==='series'?'unknown_local_or_invalid_series_id':'invalid_or_unsafe_map_id'});return;}
    if(provider!==null&&!['opendota','stratz','dota2'].includes(provider)){
      refs.push({kind,value:n,path,provider,status:'foreign_namespace'});return;
    }
    // STRATZ series IDs have no verified equivalence to OpenDota series IDs.
    const key=kind==='map'?n:JSON.stringify(['opendota',n]);
    const covered=kind==='map'?knownMaps.has(n):provider!=='stratz'&&knownSeries.has(key);
    refs.push({kind,value:n,path,provider,status:covered?'covered_numeric_reference':
      provider==='opendota'?'novel_explicit_native_reference':'novel_untyped_reference'});
  }
  function visit(v,path,depth,provider=null) {
    assert(++nodes<=maxNodes,'archive_node_limit');assert(depth<=maxDepth,'archive_depth_limit');
    if(typeof v==='string'){
      if(/\/(name|nickname|personaname|team_tag|localized_name|internal_name|radiant_team_name|dire_team_name)$/.test(path))return;
      const trim=v.trim();
      if(trim.startsWith('{')||trim.startsWith('[')){
        embeddedBytes+=Buffer.byteLength(v);assert(embeddedBytes<=maxEmbeddedBytes,'embedded_byte_limit');
        try{const parsed=JSON.parse(v);visit(parsed,path+'/@json',depth+1,provider);}catch(e){
          if(e instanceof SyntaxError)opaque.push({path,reason:'unparsed_structured_text'});else throw e;
        }
      }
      return;
    }
    if(!v||typeof v!=='object')return;
    if(Array.isArray(v)){for(let i=0;i<v.length;i++)visit(v[i],path+'/'+i,depth+1,provider);return;}
    if(v.syntheticOnly===true){syntheticPaths.push(path);return;}
    // A direct provider or an explicit sibling source identifies scope, never a nickname.
    const scoped=typeof v.provider==='string'?v.provider:
      typeof v.source?.provider==='string'?v.source.provider:provider;
    for(const [k,x] of Object.entries(v)){
      const p=path+'/'+pointer(k);
      if(mapKeys.has(k))reference('map',x,p,['nativeMatchId','canonical_match_id'].includes(k)?null:scoped);
      else if(seriesKeys.has(k))reference('series_key',x,p,scoped);
      else if(seriesIds.has(k))reference('series',x,p,scoped);
      else if(mapLists.has(k)||seriesLists.has(k)){
        if(Array.isArray(x))x.forEach((item,i)=>reference(mapLists.has(k)?'map':'series_key',item,p+'/'+i,scoped));
        else opaque.push({path:p,reason:'invalid_id_list'});
      }else visit(x,p,depth+1,scoped);
    }
  }
  visit(value,'',0);
  const novel=refs.filter(r=>r.status.startsWith('novel_'));
  return {format:'exposure-archive-reference-review-v1',
    status:novel.length||opaque.length?'requires_review':refs.length?'references_covered_or_foreign':
      syntheticPaths.length?'synthetic_excluded':'no_explicit_references',
    references:refs,opaque,syntheticPaths,
    summary:{nodes,references:refs.length,novelReferences:novel.length,opaque:opaque.length,
      coveredReferences:refs.filter(r=>r.status.startsWith('covered')).length,
      foreignReferences:refs.filter(r=>r.status==='foreign_namespace').length},
    novelMapIds:ordered(novel.filter(r=>r.kind==='map').map(r=>r.value)),
    novelNativeSeriesKeys:ordered(novel.filter(r=>r.kind==='series_key').map(r=>r.value)),
    unknownTextIsNotEvidenceOfAbsence:true,completeGlobalInventory:false,admissionAllowed:false};
}

export function summarizeArchiveReviews(entries) {
  const counts={};for(const e of entries)counts[e.review.status]=(counts[e.review.status]??0)+1;
  return {files:entries.length,statusCounts:counts,
    novelMapIds:ordered(entries.flatMap(e=>e.review.novelMapIds)),
    novelNativeSeriesKeys:ordered(entries.flatMap(e=>e.review.novelNativeSeriesKeys)),
    filesRequiringReview:entries.filter(e=>e.review.status==='requires_review').map(e=>e.path).sort(),
    fingerprint:sha(JSON.stringify(entries.map(e=>({path:e.path,sha256:e.sha256,review:e.review}))))};
}

export function compactReview(review) {
  const {references,...rest}=review;
  return {...rest,references:references.filter(r=>r.status.startsWith('novel_')),
    referenceFingerprint:sha(JSON.stringify(references))};
}
