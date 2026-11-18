/** Descriptive source audit only. No guessed wall-clock boundary is ever promoted. */
import assert from 'node:assert/strict';
const id=x=>{assert(typeof x==='string'&&/^[1-9]\d{0,18}$/.test(x),'invalid_id');return x;};
const number=x=>Number.isFinite(x)&&typeof x==='number'?x:null;
const numericId=x=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0?String(x):typeof x==='string'?id(x):null;
function events(players,key){
 const rows=players.flatMap(p=>Array.isArray(p[key])?p[key]:[]),times=rows.map(r=>number(r?.time)).filter(t=>t!==null);
 return {rows:rows.length,validTimes:times.length,negative:times.filter(t=>t<0).length,minimum:times.length?Math.min(...times):null};
}
export function summarizeGameplayClocks({ids,opendota,stratz,local}){
 assert(ids.length>0&&ids.length<=3&&new Set(ids).size===ids.length,'sample_size');ids.forEach(id);
 assert(Array.isArray(opendota)&&opendota.length<=3&&Array.isArray(local)&&local.length<=3,'source_size');
 assert(!stratz?.errors?.length,'graphql_errors');
 const lookup=(rows,key)=>{const map=new Map();for(const r of rows){const i=numericId(r[key]);assert(i&&ids.includes(i)&&!map.has(i),'foreign_or_duplicate_map');map.set(i,r);}return map;};
 const od=lookup(opendota,'match_id'),prior=lookup(local,'matchId');
 const sr=lookup(ids.flatMap((_,i)=>stratz?.data?.['m'+i]?[stratz.data['m'+i]]:[]),'id');
 const items=ids.map(matchId=>{
  const o=od.get(matchId),s=sr.get(matchId),l=prior.get(matchId),players=Array.isArray(o?.players)?o.players:[];
  const pauses=Array.isArray(o?.pauses)?o.pauses:null;
  const durations=pauses?.map(p=>number(p.duration))??[];
  const validPauses=durations.every(d=>d!==null&&d>=0);
  const start=number(o?.start_time),duration=number(o?.duration),ss=number(s?.startDateTime),se=number(s?.endDateTime),sd=number(s?.durationSeconds);
  const draft=Array.isArray(o?.draft_timings)?o.draft_timings:null;
  const wardEvents=events(players,'obs_log'),sentryEvents=events(players,'sen_log');
  return {matchId,openDotaPresent:!!o,stratzPresent:!!s,localVerifiedProReceiptPresent:!!l,
   openDota:{startTime:start,durationSeconds:duration,preGameDurationSeconds:number(o?.pre_game_duration),
     draftTimingRows:draft?.length??null,draftRowsWithTime:draft?.filter(p=>number(p.time)!==null).length??null,
     pauseRows:pauses?.length??null,pauseSeconds:pauses&&validPauses?durations.reduce((a,b)=>a+b,0):null,
     observerWards:wardEvents,sentries:sentryEvents},
   stratz:{startDateTime:ss,endDateTime:se,durationSeconds:sd,endMinusStartMinusDuration:ss!==null&&se!==null&&sd!==null?se-ss-sd:null},
   agreement:{start:ss!==null&&start!==null?ss===start:null,duration:sd!==null&&duration!==null?sd===duration:null,
     savedStart:l&&start!==null?l.payload.start_time===start:null,savedDuration:l&&duration!==null?l.payload.duration===duration:null},
   observedActionsBeforeGameClockZero:wardEvents.negative+sentryEvents.negative>0,
   verifiedGameplayStartedAt:null,verifiedDraftCompletedAt:null,primaryEligible:false,
   reasons:['UTC_ANCHOR_SEMANTICS_UNVERIFIED','FIRST_CONTROL_BOUNDARY_NOT_OBSERVED',
     ...(draft?.length?[]:['DRAFT_TIMINGS_MISSING_OR_EMPTY']),...(!l?['LOCAL_PRO_RECEIPT_MISSING']:[])]};
 });
 const types=[0,1,2].flatMap(i=>stratz?.data?.['t'+i]?[stratz.data['t'+i]]:[]);
 const schema=types.map(t=>({name:t.name,fields:(t.fields??[]).filter(f=>/time|date|pause|state|draft|start/i.test(f.name))
   .map(f=>({name:f.name,description:f.description??null,type:f.type}))}));
 return {format:'gameplay-boundary-audit-v1',items,schema,counts:{plannedMaps:ids.length,openDotaMaps:od.size,stratzMaps:sr.size,
   mapsWithPreZeroWardActions:items.filter(i=>i.observedActionsBeforeGameClockZero).length,
   mapsWithDraftTimingRows:items.filter(i=>(i.openDota.draftTimingRows??0)>0).length,
   mapsWithPauseRecords:items.filter(i=>(i.openDota.pauseRows??0)>0).length,verifiedGameplayStarts:0,verifiedDraftEnds:0},
  decision:'provider_clock_semantics_not_established',
  rejectedShortcuts:['provider_start_equals_gameplay','provider_start_plus_or_minus_pre_game_duration','end_minus_duration_is_independent_wall_clock','game_clock_zero_means_no_prior_actions'],
  boundaryRequirement:'after_final_draft_before_first_player_control_not_merely_before_game_clock_zero',
  transportCaveat:'fetched_at_and_known_at_are_not_event_at;later_source_can_audit_but_cannot_repair_a_missing_frozen_input',
  collectionAllowed:false,primaryEligible:false,trainingPerformed:false,deployable:false,teamAWinProbability:null};
}
