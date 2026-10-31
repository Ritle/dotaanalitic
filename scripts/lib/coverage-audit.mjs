import { canonicalId } from './match-quality.mjs';
export const COVERAGE_FIELDS=['match_id_consistent','start_time','outcome','completed_outcome','confirmed_pro','teams_2','league','series','patch',
  'players_10','identity_10','canonical_identity_10','heroes_10_unique','picks_10','draft_actions','role_hint_10','game_mode','lobby_type',
  'final_heroes_valid','draft_picks_exact','draft_heroes_match','draft_teams_match','draft_order_integrity','draft_structurally_consistent',
  'draft_order_valid','verified_patch','pre_match_lineup_known_at','post_draft_heroes_known_at','discovery_cohort_consistent'];

/** Evenly spaced historical ranks including first/last, never handpick quality successes. */
export function selectAuditMaps(discovered,sample,leagueId=null) {
  const seen=new Set(); let duplicates=0,invalid=0,outsideCohort=0;
  const candidates=[];
  for(const row of discovered) {
    const id=canonicalId(row?.match_id);
    if(id===null){invalid++;continue;}
    if(leagueId!==null&&canonicalId(row.leagueid)!==leagueId){outsideCohort++;continue;}
    if(seen.has(id)){duplicates++;continue;}
    seen.add(id);candidates.push({...row,match_id:id});
  }
  if(leagueId!==null)candidates.sort((a,b)=>(a.start_time??0)-(b.start_time??0)||
    (BigInt(a.match_id)<BigInt(b.match_id)?-1:1));
  const n=Math.min(sample,candidates.length);
  const selected=leagueId===null?candidates.slice(0,n):Array.from({length:n},(_,i)=>
    candidates[n===1?0:Math.floor(i*(candidates.length-1)/(n-1))]);
  return {selected,candidates:candidates.length,duplicates,invalid,outsideCohort,
    method:leagueId===null?'first_unique_in_proMatches_order':'uniform_rank_by_start_then_match_id_in_league'};
}
export function coverage(rows) {
  return Object.fromEntries(COVERAGE_FIELDS.map(key=>{
    const assessed=rows.filter(row=>typeof row.flags[key]==='boolean'),good=assessed.filter(row=>row.flags[key]===true);
    return [key,{count:good.length,of:assessed.length,ratio:assessed.length?Number((good.length/assessed.length).toFixed(4)):null,
      missing_match_ids:assessed.filter(row=>row.flags[key]===false).map(row=>row.match_id),
      not_assessed_match_ids:rows.filter(row=>typeof row.flags[key]!=='boolean').map(row=>row.match_id)}];
  }));
}
export function safeAuditError(error,matchId=null) {
  return {match_id:matchId,code:typeof error?.code==='string'&&/^[a-z_]{1,80}$/.test(error.code)?error.code:'audit_source_error',
    status:Number.isInteger(error?.status)?error.status:null,retry_after_ms:Number.isFinite(error?.retryAfterMs)?error.retryAfterMs:null};
}
function distribution(rows,key) {
  const groups=Object.create(null);for(const row of rows){const k=String(row[key]??'unknown');groups[k]=(groups[k]??0)+1;}return groups;
}
export function buildAuditReport({mode,requested,selection,rows,errors,requests,sourceEvidence,leagueId,generatedAt}) {
  const anomalies={};for(const row of rows)for(const code of row.anomalies)(anomalies[code]??=[]).push(row.match_id);
  const dates=rows.map(row=>row.started_at).filter(Boolean).sort();
  return {schema_version:3,mode,generated_at:generatedAt,
    status:rows.length===0?'blocked':rows.length===requested&&errors.length===0?'complete':'partial',
    requested,discovered:selection.selected.length,discovery_candidates:selection.candidates,
    selection:{method:selection.method,league_id:leagueId,selected_match_ids:selection.selected.map(row=>row.match_id),
      duplicate_ids:selection.duplicates,invalid_ids:selection.invalid,outside_cohort:selection.outsideCohort},
    details_received:rows.length,details_failed:errors.filter(error=>error.match_id!==null).length,
    coverage:coverage(rows),confirmed_pro_coverage:coverage(rows.filter(row=>row.flags.confirmed_pro===true)),
    strata:{provider_patch:distribution(rows,'provider_patch_id'),league:distribution(rows,'league_id'),
      game_mode:distribution(rows,'game_mode'),lobby_type:distribution(rows,'lobby_type'),
      started_at_min:dates[0]??null,started_at_max:dates.at(-1)??null},requests,source_evidence:sourceEvidence,anomalies,
    observations:rows,details:rows.filter(row=>row.anomalies.length>0).map(({match_id,anomalies,diagnostics})=>({match_id,anomalies,diagnostics})),errors,
    limitations:['Coverage is observational, not prediction eligibility or model accuracy',
      'Historical league sample is selected by time ranks, not representative of all leagues or patches',
      'Provider patch IDs are unverified; no verified release-time registry is populated',
      'identity_10 means ten distinct source Steam32 accounts, not verified canonical identities',
      'Current league tier evidence does not prove tier or roster availability before historical map start',
      'lane_role is a hint, not verified Pos 1-5; draft_order_valid remains unassessed',
      'Final heroes and completed lineups are retrospective facts without cutoff availability evidence',
      'No model trained; no raw payloads, profile names or account IDs saved in the report']};
}
