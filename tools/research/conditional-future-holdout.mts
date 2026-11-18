/** Offline conditional inputs only. No labels of the target, fitting, scoring, network or DB. */
import {createHash} from 'node:crypto';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {V1FeatureHistorySchema} from '../../packages/contracts/dist/index.js';
import {createV1FeatureBuilder,V1_FEATURE_POLICY} from '../../packages/prediction/dist/index.js';
import {HistorySchema,createPlayerHeroFeatureBuilder} from './player-hero-feature.mjs';

const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const Account=z.string().regex(/^[1-9]\d{0,9}$/).refine(v=>BigInt(v)<4294967295n);
const Us=z.string().regex(/^(0|[1-9]\d{0,17})$/),Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Series=z.string().refine(v=>{try{const p:unknown=JSON.parse(v);return Array.isArray(p)&&p.length===2&&p[0]==='opendota'&&Id.safeParse(p[1]).success&&JSON.stringify(p)===v;}catch{return false;}});
const Member=z.object({playerId:Id,accountId:Account,heroId:z.number().int().positive().max(2147483647).nullable(),
 slot:z.number().int().refine(v=>(v>=0&&v<=4)||(v>=128&&v<=132))}).strict();
export const ConditionalTargetSchema=z.object({matchId:Id,seriesKey:Series.nullable(),eventId:Id.nullable(),
 startedAtUs:Us,isPro:z.boolean().nullable(),radiantTeamId:Id.nullable(),direTeamId:Id.nullable(),canonicalPatchId:Id.nullable(),
 sourceSha256:Sha,knownAtUs:Us.nullable(),fetchedAtUs:Us,players:z.array(Member).max(10)}).strict();
const Case=z.object({target:ConditionalTargetSchema,history:V1FeatureHistorySchema.nullable(),heroHistory:HistorySchema.nullable()}).strict();
export const ConditionalFeatureInputSchema=Case.extend({format:z.literal('conditional-future-feature-input-v1'),
 history:V1FeatureHistorySchema,heroHistory:HistorySchema}).strict();
const SeriesInventory=z.object({seriesKey:Series,eventId:Id,complete:z.boolean(),mapIds:z.array(Id).min(1).max(100),
 completedAtUs:Us.nullable(),sourceSha256:Sha}).strict();
export const ConditionalHoldoutInputSchema=z.object({format:z.literal('conditional-future-holdout-input-v1'),syntheticOnly:z.boolean(),
 window:z.object({fromAtUs:Us,untilAtUs:Us}).strict(),eventIds:z.array(Id).min(1).max(20),inventoryComplete:z.boolean(),inventorySourceSha256:Sha,
 exposure:z.object({sourceSha256:Sha,mapIds:z.array(Id).max(100000),seriesKeys:z.array(Series).max(100000)}).strict(),
 series:z.array(SeriesInventory).max(300),cases:z.array(Case).max(300)}).strict();
const cmp=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const unique=(values:string[],reason:string)=>{if(new Set(values).size!==values.length)throw Error(reason);};
const memberKeys=(ps:{playerId:string;accountId:string}[])=>ps.map(p=>p.playerId+':'+p.accountId).sort();
function canonical(v:unknown):string{
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(v!==null&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';
 return JSON.stringify(v);
}
export const conditionalDigest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function targetReasons(t:z.infer<typeof ConditionalTargetSchema>){
 const reasons:string[]=[];
 if(t.isPro!==true)reasons.push('TARGET_NOT_VERIFIED_PRO');
 if(t.seriesKey===null)reasons.push('TARGET_SERIES_UNKNOWN');
 if(!t.radiantTeamId||!t.direTeamId||t.radiantTeamId===t.direTeamId)reasons.push('TARGET_SIDES_UNKNOWN');
 if(t.players.length!==10||new Set(t.players.map(p=>p.slot)).size!==10||new Set(t.players.map(p=>p.playerId)).size!==10||
  new Set(t.players.map(p=>p.accountId)).size!==10)reasons.push('TARGET_LINEUP_INCOMPLETE_OR_DUPLICATE');
 if(t.players.some(p=>p.heroId===null)||new Set(t.players.map(p=>p.heroId)).size!==10)reasons.push('TARGET_HEROES_INCOMPLETE_OR_DUPLICATE');
 return reasons;
}

/** Target outcome is structurally absent. Same-series outcomes are never consumed by either recipe. */
export function buildConditionalFutureFeatures(raw:unknown){
 const input=ConditionalFeatureInputSchema.parse(raw),{target:t,history,heroHistory}=input;
 if(history.syntheticOnly!==heroHistory.syntheticOnly)throw Error('synthetic_provenance_mismatch');
 if(history.snapshotAtUs!==heroHistory.snapshotAtUs||history.warmupFromAtUs!==heroHistory.fromAtUs)throw Error('history_window_mismatch');
 unique(history.maps.map(m=>m.matchId),'duplicate_history_map');unique(heroHistory.maps.map(m=>m.matchId),'duplicate_hero_map');
 if(history.maps.some(m=>m.matchId===t.matchId)||heroHistory.maps.some(m=>m.matchId===t.matchId))throw Error('target_outcome_forbidden');
 if(canonical(history.maps.map(m=>m.matchId).sort(cmp))!==canonical(heroHistory.maps.map(m=>m.matchId).sort(cmp)))throw Error('history_denominator_mismatch');
 const heroes=new Map(heroHistory.maps.map(m=>[m.matchId,m]));
 for(const m of history.maps){
  Series.parse(m.seriesKey);const h=heroes.get(m.matchId)!;
  if(m.startedAtUs!==h.startedAtUs||m.completedAtUs!==h.completedAtUs||m.fetchedAtUs!==h.fetchedAtUs||m.payloadSha256!==h.receiptSha256||
   canonical(memberKeys([...m.teamA,...m.teamB]))!==canonical(memberKeys(h.players)))throw Error('history_binding_mismatch');
 }
 // Validate even excluded rows; invalid source facts must not disappear through filtering.
 createV1FeatureBuilder(history);createPlayerHeroFeatureBuilder(heroHistory);
 const reasons=targetReasons(t),snapshot=BigInt(history.snapshotAtUs),cutoff=BigInt(t.startedAtUs);
 if(cutoff>snapshot||BigInt(t.fetchedAtUs)>snapshot||(t.knownAtUs!==null&&BigInt(t.knownAtUs)>snapshot))reasons.push('TARGET_AFTER_SNAPSHOT');
 const mapLedger=history.maps.map(m=>({matchId:m.matchId,seriesKey:m.seriesKey,reasons:[
  ...(m.seriesKey===t.seriesKey?['TARGET_SERIES_EXCLUDED']:[]),
  ...(BigInt(m.startedAtUs)>=cutoff||BigInt(m.completedAtUs)>=cutoff?['HISTORY_NOT_STRICTLY_EARLIER']:[])]})).sort((a,b)=>cmp(a.matchId,b.matchId));
 const allowed=new Set(mapLedger.filter(m=>!m.reasons.length).map(m=>m.matchId));
 let eloSnapshot:ReturnType<ReturnType<typeof createV1FeatureBuilder>>|null=null;
 let heroSnapshot:ReturnType<ReturnType<typeof createPlayerHeroFeatureBuilder>>|null=null;
 if(!reasons.length){
  const teamASide=BigInt(t.radiantTeamId!)<BigInt(t.direTeamId!)?'radiant':'dire';
  const side=(a:boolean)=>t.players.filter(p=>(p.slot<128)===(a?teamASide==='radiant':teamASide!=='radiant'))
   .sort((a,b)=>cmp(a.playerId,b.playerId)).map(p=>({playerId:p.playerId,accountId:p.accountId,heroId:p.heroId!}));
  const teamA=side(true),teamB=side(false),strip=(ps:typeof teamA)=>ps.map(({playerId,accountId})=>({playerId,accountId}));
  eloSnapshot=createV1FeatureBuilder({...history,maps:history.maps.filter(m=>allowed.has(m.matchId))})({schemaVersion:1,
   targetMatchId:t.matchId,cutoffAtUs:t.startedAtUs,teamA:strip(teamA),teamB:strip(teamB),
   lineup:{basis:'actual_lineup_reconstructed',source:'conditional-future:'+t.sourceSha256,selectedAtUs:t.fetchedAtUs,revision:'1'}});
  const eligibleHistory=new Set(eloSnapshot.history.usedMatchIds);
  for(const row of mapLedger)if(allowed.has(row.matchId)&&!eligibleHistory.has(row.matchId))row.reasons.push('ELO_HISTORY_INELIGIBLE');
  heroSnapshot=createPlayerHeroFeatureBuilder({...heroHistory,maps:heroHistory.maps.filter(m=>eligibleHistory.has(m.matchId))})({
   targetMatchId:t.matchId,cutoffAtUs:t.startedAtUs,teamA,teamB,canonicalPatchId:t.canonicalPatchId,
   heroBasis:'reconstructed_final_receipt',selectedAtUs:t.fetchedAtUs,sourceSha256:t.sourceSha256});
  reasons.push(...eloSnapshot.reasons,...heroSnapshot.reasons);
 }
 const inputs=!reasons.length&&eloSnapshot?.features&&heroSnapshot?.feature!==null&&heroSnapshot!==null?
  {eloLogit:Math.log(10)*eloSnapshot.features.eloDifference/V1_FEATURE_POLICY.scale,observedHeroPracticeLog90Delta:heroSnapshot.feature}:null;
 const body={format:'conditional-future-features-v1',status:inputs?'ready_offline_features':'unavailable',syntheticOnly:history.syntheticOnly,
  target:t,inputs,reasons:[...new Set(reasons)].sort(),mapLedger,eloSnapshot,heroSnapshot,
  encoded:inputs?{H1:[inputs.eloLogit],H2:[inputs.eloLogit,inputs.observedHeroPracticeLog90Delta]}:null,
  evaluationBasis:'conditional_reconstructed',warnings:['DECLARED_SOURCE_EVIDENCE_NOT_AUTHENTICATED','HISTORICAL_AVAILABILITY_ASSUMED',
   'NOT_PROSPECTIVE_PERFORMANCE','SHADOW_FEATURE_POLICY_DIFFERS'],registrationAllowed:false,collectionAllowed:false,
  trainingPerformed:false,scoringPerformed:false,independentTest:false,deployable:false,teamAWinProbability:null};
 return freeze({...body,fingerprint:conditionalDigest(body)});
}

/** All cases retained. This is a declared local inventory, not proof of provider completeness. */
export function buildConditionalFutureHoldout(raw:unknown){
 const input=ConditionalHoldoutInputSchema.parse(raw),{window:w}=input;
 if(BigInt(w.fromAtUs)>=BigInt(w.untilAtUs))throw Error('invalid_window');
 for(const c of input.cases)if(c.history?.maps.some(m=>m.matchId===c.target.matchId)||c.heroHistory?.maps.some(m=>m.matchId===c.target.matchId))
  throw Error('target_outcome_forbidden');
 for(const ids of [input.eventIds,input.exposure.mapIds,input.exposure.seriesKeys,input.cases.map(c=>c.target.matchId),input.series.map(s=>s.seriesKey)])unique(ids,'duplicate_inventory');
 const cases=new Map(input.cases.map(c=>[c.target.matchId,c])),series=new Map(input.series.map(s=>[s.seriesKey,s]));
 const memberships=new Set<string>();
 for(const s of input.series){unique(s.mapIds,'duplicate_series_member');for(const id of s.mapIds){
  if(memberships.has(id))throw Error('conflicting_series_membership');memberships.add(id);
  if(cases.has(id)&&cases.get(id)!.target.seriesKey!==s.seriesKey)throw Error('series_binding_mismatch');
 }}
 const rows=[...input.cases].sort((a,b)=>cmp(a.target.matchId,b.target.matchId)).map(c=>{
  const t=c.target,s=t.seriesKey?series.get(t.seriesKey):undefined,reasons=targetReasons(t);
  if(!input.inventoryComplete)reasons.push('DENOMINATOR_UNKNOWN');
  if(!t.eventId||!input.eventIds.includes(t.eventId)||s?.eventId!==t.eventId)reasons.push('EVENT_SCOPE_MISMATCH');
  if(!s||!s.complete)reasons.push('SERIES_COMPLETENESS_UNKNOWN');
  if(!s?.mapIds.includes(t.matchId)||s.mapIds.some(id=>!cases.has(id)))reasons.push('SERIES_MEMBER_MISSING');
  if(s){
   const members=s.mapIds.flatMap(id=>cases.get(id)??[]);
   if(s.completedAtUs===null)reasons.push('SERIES_COMPLETION_UNKNOWN');
   if(members.some(m=>BigInt(m.target.startedAtUs)<BigInt(w.fromAtUs)||BigInt(m.target.startedAtUs)>=BigInt(w.untilAtUs))||
    (s.completedAtUs!==null&&(BigInt(s.completedAtUs)>=BigInt(w.untilAtUs)||members.some(m=>BigInt(m.target.startedAtUs)>=BigInt(s.completedAtUs!)))))reasons.push('SERIES_OUTSIDE_WINDOW');
   if(input.exposure.seriesKeys.includes(s.seriesKey)||s.mapIds.some(id=>input.exposure.mapIds.includes(id)))reasons.push('EXPOSED_MAP_OR_SERIES');
  }
  if(!c.history||!c.heroHistory)reasons.push('HISTORY_INPUT_MISSING');
  if((c.history&&c.history.syntheticOnly!==input.syntheticOnly)||(c.heroHistory&&c.heroHistory.syntheticOnly!==input.syntheticOnly))throw Error('synthetic_provenance_mismatch');
  const feature=!reasons.length?buildConditionalFutureFeatures({...c,format:'conditional-future-feature-input-v1'}):null;
  reasons.push(...feature?.reasons??[]);
  return {matchId:t.matchId,seriesKey:t.seriesKey,eventId:t.eventId,startedAtUs:t.startedAtUs,
   pairedEligible:!reasons.length&&feature?.inputs!==null&&feature!==null,inputs:feature?.inputs??null,
   reasons:[...new Set(reasons)].sort(),feature};
 });
 const bad=new Set(rows.filter(r=>!r.pairedEligible).map(r=>r.seriesKey));
 for(const row of rows)if(row.seriesKey&&bad.has(row.seriesKey)){
  row.pairedEligible=false;row.inputs=null;row.reasons=[...new Set([...row.reasons,'SERIES_HAS_UNAVAILABLE_MEMBER'])].sort();
 }
 const missingIds=input.series.flatMap(s=>s.mapIds.filter(id=>!cases.has(id))).sort(cmp);
 const denominator=rows.length+missingIds.length,pairedMaps=rows.filter(r=>r.pairedEligible).length;
 const body={format:'conditional-future-holdout-v1',syntheticOnly:input.syntheticOnly,evaluationBasis:'conditional_reconstructed',
  window:w,eventIds:[...input.eventIds].sort(cmp),inventorySourceSha256:input.inventorySourceSha256,exposureSourceSha256:input.exposure.sourceSha256,
  denominator,denominatorBasis:'declared_map_inventory_not_authenticated',
  denominatorComplete:input.inventoryComplete&&missingIds.length===0&&input.series.every(s=>s.complete)&&
   input.cases.every(c=>c.target.isPro===true&&c.target.eventId!==null&&input.eventIds.includes(c.target.eventId)&&
    c.target.seriesKey!==null&&series.get(c.target.seriesKey)?.mapIds.includes(c.target.matchId)),
  missingTargetIds:missingIds,pairedMaps,pairedCoverage:denominator?pairedMaps/denominator:null,
  pairedSeries:new Set(rows.filter(r=>r.pairedEligible).map(r=>r.seriesKey)).size,rows,
  warnings:['DECLARED_INVENTORY_NOT_AUTHENTICATED','NO_LABELS_OR_REAL_EVALUATION','UNREGISTERED_LOCAL_PREPARATION'],
  registrationAllowed:false,collectionAllowed:false,trainingPerformed:false,scoringPerformed:false,independentTest:false,deployable:false};
 return freeze({...body,fingerprint:conditionalDigest(body)});
}
