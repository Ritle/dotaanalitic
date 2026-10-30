import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MatchSchema, type OpenDotaMatch } from './opendota/schemas.js';
import type { ProviderObservation } from './opendota/client.js';

export const NORMALIZER_VERSION='opendota-map-v1';
export const QUALITY_POLICY='opendota-quality-v1';
export const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record=(value:unknown):Record<string,unknown> => value!==null && typeof value==='object' && !Array.isArray(value)
  ? value as Record<string,unknown> : {};
const select=(value:unknown,fields:readonly string[])=>Object.fromEntries(Object.entries(record(value)).filter(([key])=>fields.includes(key)));

export function parseSource(observation:ProviderObservation<unknown>,expectedId:string) {
  const source=z.object({provider:z.literal('opendota'),adapterVersion:z.string().min(1).max(120),
    endpoint:z.literal(`/matches/${expectedId}`),fetchedAt:z.iso.datetime(),knownAt:z.null(),payloadSha256:z.string().regex(/^[a-f0-9]{64}$/)}).parse(observation.source);
  if(createHash('sha256').update(observation.rawBody).digest('hex')!==source.payloadSha256)throw new Error('source_hash_mismatch');
  const raw:unknown=JSON.parse(observation.rawBody);
  const top=record(raw);
  const projection=select(top,['match_id','start_time','duration','radiant_win','radiant_team_id','dire_team_id',
    'leagueid','series_id','series_type','radiant_score','dire_score','patch','game_mode','lobby_type','picks_bans']);
  if('players' in top) projection.players=Array.isArray(top.players)
    ? top.players.map(player=>select(player,['player_slot','account_id','hero_id','lane_role','kills','deaths','assists','gold_per_min','xp_per_min'])) : top.players;
  for(const side of ['radiant_team','dire_team'])if(side in top)projection[side]=top[side]===null?null:select(top[side],['team_id','name','tag']);
  // Raw draft values/array ordering are retained exactly. Original response bytes
  // (chat/profile data included) are intentionally not persisted by this policy.
  const parsed=MatchSchema.safeParse(projection);
  const issues=parsed.success?[]:['SOURCE_SCHEMA_INVALID',...parsed.error.issues.slice(0,10).map(issue=>`FIELD:${issue.path.join('.')}`)];
  if(top.synthetic===true || '_fixture' in top)issues.push('SYNTHETIC_SOURCE_REJECTED');
  if(parsed.success && parsed.data.match_id!==expectedId)throw new Error('source_id_mismatch');
  return {source,projection,match:parsed.success && !issues.length?parsed.data:null,issues};
}

export function matchEventAt(match:OpenDotaMatch|null):string|null {
  return match?.start_time && match.start_time>0 && match.start_time<=253402300799
    ? new Date(match.start_time*1000).toISOString():null;
}
export function sideOf(slot:number|null|undefined):'radiant'|'dire'|null {
  if(slot!=null && slot>=0 && slot<=4)return 'radiant';
  if(slot!=null && slot>=128 && slot<=132)return 'dire';
  return null;
}
export function completedObservation(match:OpenDotaMatch,fetchedAt:string):boolean {
  const started=matchEventAt(match);
  return started!==null && match.duration!=null && match.duration>0 &&
    Date.parse(started)+match.duration*1000<=Date.parse(fetchedAt);
}
export interface QualityContext { pro:boolean|null; knownHeroes:ReadonlySet<number>; players:ReadonlyMap<string,string>;
  radiantTeamId:string|null;direTeamId:string|null;seriesId:string|null;conflict:boolean;fetchedAt:string }

export function assess(match:OpenDotaMatch,context:QualityContext) {
  const players=match.players??[];
  const slots=players.map(player=>player.player_slot);
  const slotsValid=slots.length===10 && new Set(slots).size===10 && slots.every(slot=>sideOf(slot)!==null);
  const heroIds=players.map(player=>player.hero_id);
  const heroesValid=slotsValid && heroIds.every(id=>id!=null && id>0 && context.knownHeroes.has(id)) && new Set(heroIds).size===10;
  const accounts=players.map(player=>player.account_id);
  const sourceIdentities=slotsValid && accounts.every(id=>id!=null) && new Set(accounts).size===10;
  const canonical=accounts.map(id=>id==null?null:context.players.get(id)??null);
  const identities=sourceIdentities && canonical.every(id=>id!==null) && new Set(canonical).size===10;
  const teamsKnown=match.radiant_team_id!=null && match.dire_team_id!=null && match.radiant_team_id!==match.dire_team_id;
  const actions=match.picks_bans;
  const picks=actions?.filter(action=>action.is_pick===true)??[];
  const picked=picks.map(action=>action.hero_id);
  const exact=picks.length===10 && new Set(picked).size===10 && heroesValid && picked.every(id=>heroIds.includes(id));
  const sides=exact && picks.every(action=>players.some(player=>player.hero_id===action.hero_id &&
    (action.team===0?sideOf(player.player_slot)==='radiant':action.team===1?sideOf(player.player_slot)==='dire':false)));
  const orders=actions?.map(action=>action.order)??[];
  const ordered=orders.length>0 && orders.every(order=>order!=null && Number.isInteger(order) && order>=0) && new Set(orders).size===orders.length;
  const anomalies:string[]=[];
  const completed=completedObservation(match,context.fetchedAt);
  if(!completed)anomalies.push('MAP_COMPLETION_UNVERIFIED');
  if(!teamsKnown)anomalies.push('TEAM_ID_MISSING');
  if(match.radiant_team_id!=null && match.radiant_team_id===match.dire_team_id)anomalies.push('TEAM_ID_CONFLICT');
  if(!context.radiantTeamId||!context.direTeamId)anomalies.push('TEAM_REFERENCE_UNRESOLVED');
  if(!match.series_id)anomalies.push('SERIES_ID_UNKNOWN');
  else if(!context.seriesId)anomalies.push('SERIES_REFERENCE_UNRESOLVED');
  if(!slotsValid)anomalies.push('PLAYER_SLOTS_INVALID');
  if(!sourceIdentities)anomalies.push('PLAYER_ID_MISSING_OR_DUPLICATE');
  if(!identities)anomalies.push('CANONICAL_IDENTITIES_UNRESOLVED');
  if(!heroesValid)anomalies.push('FINAL_HEROES_UNRESOLVED_OR_INVALID');
  if(!actions?.length)anomalies.push('DRAFT_EVENTS_MISSING');
  if(actions && picks.length!==10)anomalies.push(picks.length>10?'PICK_COUNT_EXTRA':'PICK_COUNT_MISSING');
  if(actions && picked.some(id=>id!=null && !heroIds.includes(id)))anomalies.push('PICK_EXTRA_HERO');
  if(actions && heroesValid && heroIds.some(id=>!picked.includes(id)))anomalies.push('PICK_MISSING_HERO');
  if(exact&&!sides)anomalies.push('DRAFT_SIDE_MISMATCH');
  if(actions?.length&&!ordered)anomalies.push('DRAFT_ORDER_INVALID_SHAPE');
  anomalies.push('PATCH_METADATA_UNVERIFIED','ROLE_UNVERIFIED','DRAFT_RULES_UNVERIFIED','LINEUP_KNOWN_AT_UNKNOWN');
  if(context.pro===null)anomalies.push('PRO_CLASSIFICATION_UNKNOWN');
  if(context.pro===false)anomalies.push('NON_PRO_LEAGUE');
  if(context.conflict)anomalies.push('CANONICAL_SOURCE_CONFLICT');
  const status=(eligible:boolean):'eligible'|'unknown'=>eligible?'eligible':'unknown';
  return {
    outcome_status:context.conflict?'ineligible' as const:context.pro===false?'ineligible' as const:
      status(context.pro===true && typeof match.radiant_win==='boolean' && completed),
    player_status:status(identities),final_heroes_status:heroesValid?'eligible' as const:'ineligible' as const,
    organization_status:status(teamsKnown && !!context.radiantTeamId && !!context.direTeamId),
    series_status:status(!!context.seriesId),
    draft_timeline_status:!actions?.length?'missing' as const:exact&&sides&&ordered?'unknown' as const:'structurally_inconsistent' as const,
    draft_order_valid:null,anomalies,
    metrics:{n_raw:1,completed_observation:completed,slots_valid:slotsValid,source_accounts_10:sourceIdentities,canonical_players_10:identities,
      final_heroes_valid:heroesValid,pick_events:actions?picks.length:null,draft_events:actions?.length??null,
      draft_picks_exact:actions?picks.length===10:null,draft_heroes_match:actions?exact:null,draft_teams_match:actions?sides:null,
      draft_order_integrity:actions?ordered:null,draft_order_valid:null,first_pick_side:null,
      game_mode:match.game_mode??null,lobby_type:match.lobby_type??null,provider_patch_id:match.patch??null,
      patch_id:null,known_at:null,availability:'retrospective_fact'}
  };
}

export function classifyLeague(tier:string|null|undefined):boolean|null {
  if(tier==='professional'||tier==='premium')return true;
  if(tier==='amateur'||tier==='excluded')return false;
  return null;
}
