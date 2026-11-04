import {V1JournalInputV3Schema,V1JournalCurrentFiltersSchema,V1JournalSummaryV3Schema,type V1JournalObservation} from '@dota/contracts';
import {buildV1Journal} from './v1-journal.js';
import {forecastMetrics} from '@dota/analytics';
const lifecycleTargetKey=(t:{provider:'opendota';providerSeriesId:string;mapNumber:number}|{provider:'pandascore';providerMatchId:string;mapNumber:number})=>
  `${t.provider}:${t.provider==='opendota'?t.providerSeriesId:t.providerMatchId}:${t.mapNumber}`;
const clock=(v:string)=>v.replace(/\.(\d+)Z$/,(_,f:string)=>'.'+f.padEnd(6,'0')+'Z');
export function buildV1JournalV3(value:unknown,filterValue:unknown){
  const input=V1JournalInputV3Schema.parse(value),filters=V1JournalCurrentFiltersSchema.parse(filterValue);
  const {lifecycle,scheduledLifecycle,scheduledBindings,...legacy}=input;
  const allLifecycle=[...lifecycle,...scheduledLifecycle];
  const base=buildV1Journal({...legacy,format:'v1-journal-input-v1'},{});
  const states=new Map(allLifecycle.map(e=>[lifecycleTargetKey(e.event.target),e]));
  if(states.size!==allLifecycle.length)throw Error('journal_duplicate_lifecycle');
  const observations=new Map(input.observations.map(o=>[o.id,o]));
  const targets=new Set(input.observations.flatMap(o=>o.target?[lifecycleTargetKey(o.target)]:[]));
  for(const s of lifecycle){if(s.event.recordedAt>input.capturedAt||!targets.has(lifecycleTargetKey(s.event.target)))throw Error('journal_invalid_lifecycle');}
  for(const s of scheduledLifecycle)if(s.event.recordedAt>input.capturedAt)throw Error('journal_invalid_lifecycle');
  if(new Set(scheduledBindings.map(b=>b.requestId)).size!==scheduledBindings.length)throw Error('journal_duplicate_scheduled_binding');
  for(const b of scheduledBindings)if(b.reviewedAt>input.capturedAt)throw Error('journal_future_scheduled_binding');
  // An ever-verified target binding wins even if a later provider correction is unresolved.
  // A manual cancellation can never remove a scored map or hide a corrected outcome.
  const bound=new Set(input.observations.filter(o=>o.target&&(o.binding||o.bindingConflict)).map(o=>lifecycleTargetKey(o.target!)));
  for(const b of scheduledBindings)bound.add(lifecycleTargetKey({provider:'pandascore',providerMatchId:b.providerMatchId,mapNumber:1}));
  const rows=base.rows.map(row=>{
    const o=observations.get(row.predictionId)!,key=o.target?lifecycleTargetKey(o.target):null,s=key?states.get(key):null;
    if(s?.event.request.action!=='cancelled')return row;
    if(bound.has(key!))return {...row,reasons:[...row.reasons,'CANCELLATION_IGNORED_VERIFIED_BINDING']};
    return {...row,status:'cancelled' as const,correct:null,reasons:[...row.reasons,'OWNER_REPORTED_CANCELLATION']};
  }).filter(row=>{const o=observations.get(row.predictionId)!;return (!filters.modelId||o.modelId===filters.modelId)&&
    (!filters.fromAt||o.createdAt>=clock(filters.fromAt))&&(!filters.until||o.createdAt<clock(filters.until))&&(!filters.status||row.status===filters.status);});
  const selected=rows.map(row=>({row,o:observations.get(row.predictionId)!})),scored=selected.filter(x=>x.row.status==='primary');
  const metrics=(os:V1JournalObservation[])=>forecastMetrics(os.map(o=>({probability:o.probability!,teamAWon:o.verification!.outcome!.teamAWon})));
  const count=(s:string)=>rows.filter(r=>r.status===s).length;
  return V1JournalSummaryV3Schema.parse({...base,lifecyclePolicy:'owner_reported_verified_binding_precedence_v2',filters,rows,
    counts:{attempts:rows.length,realAttempts:selected.filter(x=>x.o.purpose==='real_map').length,whatIfAttempts:count('what_if'),
      issued:selected.filter(x=>x.o.purpose==='real_map'&&x.o.status==='done').length,
      unavailable:selected.filter(x=>x.o.purpose==='real_map'&&x.o.status==='unavailable').length,
      pendingVerification:count('pending_verification'),unlinked:count('unlinked'),excluded:count('excluded'),superseded:count('superseded'),
      primaryMaps:scored.length,verifiedMaps:new Set(selected.filter(x=>x.o.purpose==='real_map'&&x.o.verification?.status==='linked').map(x=>x.row.matchId)).size,
      cancelled:new Set(selected.filter(x=>x.row.status==='cancelled').map(x=>lifecycleTargetKey(x.o.target!))).size},
    metrics:metrics(scored.map(x=>x.o)),matchedLineupMetrics:metrics(scored.filter(x=>x.o.verification?.rosterStatus==='matched').map(x=>x.o)),
    warnings:['OWNER_REPORTED_CANCELLATIONS_ONLY','LOCAL_VERIFIED_OUTCOMES_ONLY','FILTERS_AFTER_GLOBAL_PRIMARY_SELECTION']});
}
