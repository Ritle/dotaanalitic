/** Structural source audit only; NOT a patch-specific draft/lineup certification. */
const validId=x=>Number.isSafeInteger(x)&&x>0;
const sameSet=(a,b)=>a.length===b.length && new Set(a).size===a.length && b.every(x=>a.includes(x));
const sortedUnique=a=>[...new Set(a)].sort((a,b)=>a-b);

export function inspectMatch(m,expectedId){
  const players=Array.isArray(m?.players)?m.players:[];
  const slots=players.map(p=>p?.player_slot);
  const properSlots=slots.length===10&&new Set(slots).size===10&&[0,1,2,3,4,128,129,130,131,132].every(x=>slots.includes(x));
  const finalHeroIds=players.map(p=>p?.hero_id);
  const finalHeroesValid=properSlots&&finalHeroIds.every(validId)&&new Set(finalHeroIds).size===10;
  const actions=Array.isArray(m?.picks_bans)?m.picks_bans:null;
  const picks=(actions??[]).filter(a=>a?.is_pick===true);
  const pickedHeroes=picks.map(a=>a?.hero_id);
  const picksExactlyTen=actions!==null&&picks.length===10;
  const allPickedIdsValid=picks.every(a=>validId(a?.hero_id));
  const heroSetsMatch=finalHeroesValid&&actions!==null&&allPickedIdsValid&&sameSet(pickedHeroes,finalHeroIds);
  const radiant=players.filter(p=>properSlots&&p.player_slot<128).map(p=>p.hero_id);
  const dire=players.filter(p=>properSlots&&p.player_slot>=128).map(p=>p.hero_id);
  const radiantPicks=picks.filter(p=>p?.team===0).map(p=>p.hero_id);
  const direPicks=picks.filter(p=>p?.team===1).map(p=>p.hero_id);
  const sidesMatch=heroSetsMatch&&sameSet(radiantPicks,radiant)&&sameSet(direPicks,dire);
  const orders=(actions??[]).map(a=>a?.order);
  const orderIntegrity=actions!==null&&actions.length>0&&orders.every(n=>Number.isInteger(n)&&n>=0)&&new Set(orders).size===orders.length;
  const twoTeams=validId(m?.radiant_team_id)&&validId(m?.dire_team_id)&&m.radiant_team_id!==m.dire_team_id;
  const series=validId(m?.series_id);
  const flags={
    match_id_consistent:validId(m?.match_id)&&m.match_id===expectedId,
    start_time:validId(m?.start_time),
    outcome:typeof m?.radiant_win==='boolean',
    teams_2:twoTeams,
    league:validId(m?.leagueid),
    series,
    patch:m?.patch!==null&&m?.patch!==undefined&&(typeof m.patch==='string'||Number.isSafeInteger(m.patch)),
    players_10:properSlots,
    identity_10:properSlots&&players.every(p=>validId(p?.account_id)),
    heroes_10_unique:finalHeroesValid,
    picks_10:picksExactlyTen,
    draft_actions:actions!==null&&actions.length>0,
    role_hint_10:properSlots&&players.every(p=>Number.isInteger(p?.lane_role)),
    final_heroes_valid:finalHeroesValid,
    draft_picks_exact:picksExactlyTen,
    draft_heroes_match:heroSetsMatch,
    draft_teams_match:sidesMatch,
    draft_order_integrity:orderIntegrity,
    draft_structurally_consistent:picksExactlyTen&&heroSetsMatch&&sidesMatch&&orderIntegrity,
    // Requires a verified game mode + patch/league-specific drafting rules (not present in v9).
    draft_order_valid:null,
  };
  const anomalies=[];
  if(!twoTeams) anomalies.push('TEAM_ID_MISSING');
  if(!series) anomalies.push('SERIES_ID_UNKNOWN');
  if(actions===null||actions.length===0) anomalies.push('DRAFT_EVENTS_MISSING');
  if(actions!==null && picks.length>10) anomalies.push('PICK_COUNT_EXTRA');
  if(actions!==null && picks.length<10) anomalies.push('PICK_COUNT_MISSING');
  if(finalHeroesValid&&actions!==null){
    if(sortedUnique(pickedHeroes.filter(validId)).some(h=>!finalHeroIds.includes(h)))anomalies.push('PICK_EXTRA_HERO');
    if(finalHeroIds.some(h=>!pickedHeroes.includes(h)))anomalies.push('PICK_MISSING_HERO');
  }
  if(heroSetsMatch&&!sidesMatch) anomalies.push('DRAFT_SIDE_MISMATCH');
  if(actions!==null&&actions.length>0&&!orderIntegrity) anomalies.push('DRAFT_ORDER_INVALID_SHAPE');
  return {flags,anomalies,diagnostics:{final_heroes_count:finalHeroIds.filter(validId).length,pick_events:picks.length,unique_picked_heroes:new Set(pickedHeroes.filter(validId)).size,draft_events:actions?.length??null,extra_hero_ids:finalHeroesValid?sortedUnique(pickedHeroes.filter(validId).filter(h=>!finalHeroIds.includes(h))):[],missing_hero_ids:finalHeroesValid?sortedUnique(finalHeroIds.filter(h=>!pickedHeroes.includes(h))):[],game_mode:m?.game_mode??null,lobby_type:m?.lobby_type??null}};
}
