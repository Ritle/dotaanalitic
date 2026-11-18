/** Archived source membership, not model eligibility or historical pre-start availability. */
import assert from 'node:assert/strict';
import {valveProjection} from './exposure-namespace-core.mjs';
import {auditSeriesCorpus} from './series-corpus-core.mjs';
const id=v=>{if(typeof v==='number')assert(Number.isSafeInteger(v),'unsafe_native_id');
  const s=String(v);assert(/^[1-9]\d*$/.test(s),'invalid_native_id');return s;};
const sorted=xs=>[...xs].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
const same=(a,b)=>[...a,...b].every(x=>typeof x==='string'&&/^[1-9]\d*$/.test(x))&&JSON.stringify(sorted(a))===JSON.stringify(sorted(b));
const bestOf=type=>({1:1,2:3,3:5,4:2})[type]??null;
const seriesType=type=>({0:1,1:3,2:5,3:2})[type]??null;
const clock=s=>{const n=Date.parse(s);assert(Number.isFinite(n),'invalid_clock');return n;};
const optionalEpoch=n=>Number.isSafeInteger(n)&&n>0?new Date(n*1000).toISOString():null;
export function valveMembershipSource(bytes,receipt,path){
  valveProjection(bytes,receipt,path); // SHA, endpoint, league and native ID checks.
  const raw=JSON.parse(bytes),nodes=[],infos=new Map();
  for(const s of raw.series_infos){const key=id(s.series_id);assert(!infos.has(key),'duplicate_series_info');infos.set(key,s);}
  let visited=0;
  function walk(g,depth){assert(depth<=20&&++visited<=10000,'node_group_limit');
    assert(Array.isArray(g.nodes)&&Array.isArray(g.node_groups),'node_group_shape');
    nodes.push(...g.nodes);assert(nodes.length<=10000,'node_limit');for(const child of g.node_groups)walk(child,depth+1);}
  raw.node_groups.forEach(g=>walk(g,0));
  const seen=new Set();
  const rows=nodes.map(n=>{
    const nodeId=id(n.node_id);assert(!seen.has(nodeId),'duplicate_node');seen.add(nodeId);
    const providerSeriesId=n.series_id===0?null:id(n.series_id),info=infos.get(providerSeriesId);
    assert(Array.isArray(n.matches)&&n.matches.length<=100,'node_map_limit');
    const matches=n.matches.map(m=>({id:id(m.match_id),winner:id(m.winning_team_id),duration:m.duration}));
    const mapIds=matches.map(m=>m.id),reasons=[];
    if(new Set(mapIds).size!==mapIds.length)reasons.push('DUPLICATE_SOURCE_MAP');
    if(n.has_started!==true||n.is_completed!==true)reasons.push('SOURCE_NODE_NOT_COMPLETED');
    if(!info)reasons.push('SOURCE_SERIES_INFO_MISSING');
    const teams=[n.team_id_1,n.team_id_2].map(v=>v===0?'0':id(v));
    if(teams.some(t=>!/^[1-9]\d*$/.test(t))||teams[0]===teams[1])reasons.push('SOURCE_TEAMS_UNKNOWN');
    if(info){const ids=info.match_ids.map(id);
      if(new Set(ids).size!==ids.length||!same(ids,mapIds))reasons.push('SOURCE_MAP_LIST_DISAGREEMENT');
      if(!same([id(info.team_id_1),id(info.team_id_2)],teams))reasons.push('SOURCE_TEAM_LIST_DISAGREEMENT');
      if(bestOf(n.node_type)===null||bestOf(n.node_type)!==seriesType(info.series_type))reasons.push('SOURCE_FORMAT_DISAGREEMENT');}
    const wins=teams.map(t=>matches.filter(m=>m.winner===t).length),score=[n.team_1_wins,n.team_2_wins];
    if(!score.every(v=>Number.isSafeInteger(v)&&v>=0)||score[0]!==wins[0]||score[1]!==wins[1]||score[0]+score[1]!==matches.length)
      reasons.push('SOURCE_SCORE_MAP_COUNT_MISMATCH');
    if(matches.some(m=>!teams.includes(m.winner)))reasons.push('SOURCE_WINNER_OUTSIDE_TEAMS');
    return {nodeId,providerSeriesId,leagueId:id(raw.info.league_id),bestOf:bestOf(n.node_type),teams,matches,mapIds,
      score,reportedNodeStartAt:optionalEpoch(n.actual_time),reportedSeriesStartAt:optionalEpoch(info?.start_time),reasons};
  });
  return {source:{path,sha256:receipt.sha256,url:receipt.url,fetchedAt:receipt.fetchedAt??receipt.savedAt},rows};
}

export function auditSeriesMembership(corpus,exposure,sources){
  assert.equal(corpus.format,'series-corpus-export-v1');
  for(const p of corpus.plans)assert.equal(p.request.snapshotAt,corpus.snapshotAt,'corpus_clock');
  assert.deepEqual(auditSeriesCorpus(corpus.plans,exposure),corpus.audit,'corpus_audit_replay');
  assert.equal(new Set(sources.map(s=>s.source.sha256)).size,sources.length,'duplicate_source');
  const groups=new Map(corpus.plans.flatMap(p=>p.groups).map(g=>[g.providerSeriesId,g]));
  const all=sources.flatMap(s=>s.rows.map(row=>({source:s.source,row})));
  const rows=corpus.audit.rows.map(local=>{
    const group=groups.get(local.providerSeriesId),reasons=[...local.reasons];
    // Native map overlap binds namespaces. Equal provider series numbers alone never bind.
    const candidates=all.filter(({row})=>row.mapIds.some(id=>local.mapIds.includes(id)));
    if(!candidates.length)reasons.push('MEMBERSHIP_SOURCE_MISSING');
    if(candidates.length>1)reasons.push('MEMBERSHIP_SOURCE_AMBIGUOUS');
    const selected=candidates.length===1?candidates[0]:null;
    let missingMapIds=[],extraMapIds=[];
    if(selected){const {row:s,source}=selected;reasons.push(...s.reasons);
      if(clock(source.fetchedAt)>clock(corpus.snapshotAt))reasons.push('SOURCE_AFTER_CORPUS_SNAPSHOT');
      missingMapIds=s.mapIds.filter(id=>!local.mapIds.includes(id));extraMapIds=local.mapIds.filter(id=>!s.mapIds.includes(id));
      if(missingMapIds.length||extraMapIds.length)reasons.push('CANONICAL_MEMBERSHIP_MISMATCH');
      if(s.bestOf!==group.bestOf)reasons.push('CANONICAL_FORMAT_MISMATCH');
      for(const m of group.maps){
        if(m.externalLeague!==s.leagueId||!same([m.externalRadiant,m.externalDire],s.teams))reasons.push('CANONICAL_SOURCE_REFERENCES_MISMATCH');
        const evidence=s.matches.find(x=>x.id===m.id),o=m.outcome;
        if(!evidence||o.status!=='verified')continue;
        const winner=o.teamAWon?o.teamAId:o.teamBId;
        const nativeWinner=winner===m.radiant?m.externalRadiant:winner===m.dire?m.externalDire:null;
        if(nativeWinner!==evidence.winner)reasons.push('CANONICAL_SOURCE_WINNER_MISMATCH');
        const duration=(clock(o.completedAt)-clock(o.startedAt))/1000;
        if(!Number.isSafeInteger(evidence.duration)||evidence.duration!==duration)reasons.push('CANONICAL_SOURCE_DURATION_MISMATCH');
        if(clock(o.completedAt)>clock(source.fetchedAt))reasons.push('SOURCE_OBSERVED_BEFORE_MAP_COMPLETION');
      }
    }
    const unique=[...new Set(reasons)].sort(),verified=unique.length===0;
    const ordered=[...group.maps].sort((a,b)=>clock(a.startedAt)-clock(b.startedAt));
    return {providerSeriesId:local.providerSeriesId,bestOf:local.bestOf,mapIds:local.mapIds,
      membershipStatus:verified?'verified_from_archived_source':'unavailable',seriesLabelReady:verified,
      verifiedSeriesStartAt:verified?ordered[0].startedAt:null,completedAt:verified?ordered.at(-1).outcome.completedAt:null,
      winnerTeamId:verified?local.observedWinnerTeamId:null,reasons:unique,missingMapIds,extraMapIds,
      source:selected?{...selected.source,valveLeagueId:selected.row.leagueId,valveSeriesId:selected.row.providerSeriesId,nodeId:selected.row.nodeId,
        mapIds:selected.row.mapIds,score:selected.row.score,reportedNodeStartAt:selected.row.reportedNodeStartAt,
        reportedSeriesStartAt:selected.row.reportedSeriesStartAt}:null,
      availability:'historically_reconstructed_not_prestart_known',independent:false,datasetEligible:false};
  });
  const byFormat={},reasons={};for(const r of rows){const f=byFormat[r.bestOf]??={series:0,sourced:0,verified:0};
    f.series++;f.sourced+=Number(r.source!==null);f.verified+=Number(r.seriesLabelReady);for(const reason of r.reasons)reasons[reason]=(reasons[reason]??0)+1;}
  return {format:'series-membership-audit-v1',purpose:'development_source_validation',deployable:false,
    summary:{series:rows.length,sourceNodes:all.length,verifiedSeries:rows.filter(r=>r.seriesLabelReady).length,
      verifiedMaps:rows.filter(r=>r.seriesLabelReady).reduce((n,r)=>n+r.mapIds.length,0),independentSeries:0,datasetEligibleSeries:0,byFormat,reasons},rows};
}
