/** Shadow-only nullable-target revision. Frozen v1 recipe retained; callers exclude possible target maps before this kernel. */
import {z} from 'zod';

const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const Account=z.string().regex(/^[1-9]\d{0,9}$/).refine(v=>BigInt(v)<4294967295n);
const Time=z.string().regex(/^\d{1,19}$/).refine(v=>BigInt(v)<=8640000000000000000n);
const Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Hero=z.number().int().positive().max(2147483647);
const Member=z.object({playerId:Id,accountId:Account,heroId:Hero.nullable()}).strict();
const TargetMember=Member.extend({heroId:Hero}).strict();
const MapSchema=z.object({matchId:Id,startedAtUs:Time,completedAtUs:Time,fetchedAtUs:Time,knownAtUs:Time.nullable(),
 isPro:z.literal(true),receiptSha256:Sha,canonicalPatchId:Id.nullable(),
 players:z.array(Member).length(10)}).strict();
export const HistorySchema=z.object({format:z.literal('verified-player-hero-history-v1'),syntheticOnly:z.boolean(),sourceSha256:Sha,
 fromAtUs:Time,toAtUs:Time,snapshotAtUs:Time,maps:z.array(MapSchema).max(5000)}).strict();
export const ScenarioSchema=z.object({targetMatchId:Id.nullable(),cutoffAtUs:Time,teamA:z.array(TargetMember).length(5),teamB:z.array(TargetMember).length(5),
 canonicalPatchId:Id.nullable(),heroBasis:z.enum(['reconstructed_final_receipt','owner_selected']),
 selectedAtUs:Time,sourceSha256:Sha}).strict();
export const FEATURE_POLICY=Object.freeze({version:'player-hero-observed-practice-90d-shadow-v2',featureOrder:Object.freeze(['observedHeroPracticeLog90Delta'] as const),
 days:90,window:'started_at_in_[cutoff-90days,cutoff);completed_at<cutoff',transform:'natural_log1p_count',
 aggregate:'mean_of_five_A_minus_mean_of_five_B',count:'one_verified_pro_map_per_same_player_account_hero',
 patch:'all_patches_observed_volume_only_no_transfer_or_performance_claim',role:'all_roles_no_inference',
 availability:'conditional_event_time_assumed',missing:'observed_zero_is_not_absence_of_experience;unknown_hero_maps_reported_separately',
 fitting:false,probabilities:false,deployable:false} as const);
type MemberType=z.infer<typeof Member>;
type HistoryType=z.infer<typeof HistorySchema>;
const key=(p:MemberType)=>`${p.playerId}:${p.accountId}`;
const numeric=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
function uniquePlayers(players:MemberType[],heroesRequired:boolean):void{
 if(new Set(players.map(p=>p.playerId)).size!==players.length||new Set(players.map(p=>p.accountId)).size!==players.length)throw Error('duplicate_player_or_account');
 const heroes=players.flatMap(p=>p.heroId===null?[]:[p.heroId]);
 if(new Set(heroes).size!==heroes.length||(heroesRequired&&heroes.length!==10))throw Error('duplicate_or_missing_hero');
}

/** Validation once per capture; closure owns a parsed copy, so callers cannot mutate its history. */
export function createPlayerHeroFeatureBuilder(input:unknown){
 const history=HistorySchema.parse(input),from=BigInt(history.fromAtUs),to=BigInt(history.toAtUs),snapshot=BigInt(history.snapshotAtUs);
 if(from>=to||to>snapshot||new Set(history.maps.map(m=>m.matchId)).size!==history.maps.length)throw Error('history_window_or_duplicate');
 type Entry={map:HistoryType['maps'][number];player:MemberType};
 const byPlayer=new Map<string,Entry[]>();
 for(const map of history.maps){
  const start=BigInt(map.startedAtUs),end=BigInt(map.completedAtUs),fetched=BigInt(map.fetchedAtUs);
  if(start<from||start>=to||start>=end||end>snapshot||fetched>snapshot||(map.knownAtUs!==null&&BigInt(map.knownAtUs)>snapshot))throw Error('invalid_history_clock');
  uniquePlayers(map.players,false);
  for(const player of map.players){const entries=byPlayer.get(key(player))??[];entries.push({map,player});byPlayer.set(key(player),entries);}
 }
 for(const entries of byPlayer.values())entries.sort((a,b)=>numeric(a.map.matchId,b.map.matchId));
 return (inputScenario:unknown)=>{
  const scenario=ScenarioSchema.parse(inputScenario);uniquePlayers([...scenario.teamA,...scenario.teamB],true);
  const cutoff=BigInt(scenario.cutoffAtUs),windowFrom=cutoff-BigInt(FEATURE_POLICY.days)*86400000000n;
  const reasons:string[]=[];
  if(windowFrom<from)reasons.push('HISTORY_WINDOW_START_TRUNCATED');
  if(cutoff>to)reasons.push('HISTORY_WINDOW_END_TRUNCATED');
  const side=(players:z.infer<typeof TargetMember>[])=>players.slice().sort((a,b)=>numeric(a.accountId,b.accountId)).map(player=>{
   const prior=(byPlayer.get(key(player))??[]).filter(e=>e.map.matchId!==scenario.targetMatchId&&BigInt(e.map.startedAtUs)>=windowFrom&&
    BigInt(e.map.startedAtUs)<cutoff&&BigInt(e.map.completedAtUs)<cutoff);
   const same=prior.filter(e=>e.player.heroId===player.heroId),unknown=prior.filter(e=>e.player.heroId===null);
   return {...player,nRaw:same.length,log1pCount:Math.log1p(same.length),priorProMaps:prior.length,
    heroUnknownMaps:unknown.length,heroUnknownMatchIds:unknown.map(e=>e.map.matchId),matchIds:same.map(e=>e.map.matchId),
    knownBeforeCutoffMaps:same.filter(e=>e.map.knownAtUs!==null&&BigInt(e.map.knownAtUs)<cutoff&&BigInt(e.map.fetchedAtUs)<cutoff).length,
    canonicalPatchUnknownMaps:same.filter(e=>e.map.canonicalPatchId===null).length,
    sameCanonicalPatch:scenario.canonicalPatchId===null?null:same.filter(e=>e.map.canonicalPatchId===scenario.canonicalPatchId).length};
  });
  const teamA=side(scenario.teamA),teamB=side(scenario.teamB),players=[...teamA,...teamB];
  const mean=(p:typeof teamA)=>p.reduce((sum,x)=>sum+x.log1pCount,0)/5;
  const warnings=['LOCAL_HISTORY_NOT_EXHAUSTIVE','ZERO_COUNT_NOT_ZERO_EXPERIENCE','ROLE_NOT_CONDITIONED','PATCH_TRANSFER_NOT_VALIDATED','CONDITIONAL_EVENT_TIME_ASSUMED','TARGET_EXCLUSION_REQUIRED_BY_SHADOW_ADAPTER'];
  if(scenario.heroBasis==='reconstructed_final_receipt')warnings.push('TARGET_HERO_RECONSTRUCTED');
  if(BigInt(scenario.selectedAtUs)>=cutoff)warnings.push('LINEUP_SELECTED_AT_OR_AFTER_CUTOFF');
  if(scenario.canonicalPatchId===null)warnings.push('TARGET_CANONICAL_PATCH_UNKNOWN');
  if(players.some(p=>p.heroUnknownMaps>0))warnings.push('HERO_HISTORY_INCOMPLETE');
  if(players.some(p=>p.nRaw===0))warnings.push('NO_OBSERVED_HERO_PRACTICE');
  if(players.some(p=>p.knownBeforeCutoffMaps<p.nRaw))warnings.push('HISTORY_AVAILABILITY_NOT_ESTABLISHED');
  const feature=reasons.length?null:mean(teamA)-mean(teamB);
  return {format:'player-hero-feature-shadow-v2',policyVersion:FEATURE_POLICY.version,status:reasons.length?'unavailable':'computed_research_only',
   featureOrder:FEATURE_POLICY.featureOrder,feature,teamAMean:reasons.length?null:mean(teamA),teamBMean:reasons.length?null:mean(teamB),
   reasons,warnings,teamA,teamB,scenario,window:{fromAtUs:windowFrom.toString(),untilAtUs:scenario.cutoffAtUs},
   history:{sourceSha256:history.sourceSha256,fromAtUs:history.fromAtUs,toAtUs:history.toAtUs,snapshotAtUs:history.snapshotAtUs,
    usedMatchIds:[...new Set(players.flatMap(p=>p.matchIds))].sort(numeric)},
   syntheticOnly:history.syntheticOnly,trainingPerformed:false,scoringPerformed:false,publicationEligible:false,deployable:false};
 };
}
