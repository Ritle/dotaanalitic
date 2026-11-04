import { V1JournalInputSchema,V1JournalFiltersSchema,V1JournalSummarySchema,type V1JournalObservation } from '@dota/contracts';
import { forecastMetrics,FORECAST_LOG_LOSS_CLIP,FORECAST_METRIC_POLICY } from '@dota/analytics';
const timeKey=(value:string)=>value.replace(/\.(\d+)Z$/,(_,fraction:string)=>'.'+fraction.padEnd(6,'0')+'Z');
const compare=(a:V1JournalObservation,b:V1JournalObservation)=>{
  for(const [x,y] of [[a.issuedAt!,b.issuedAt!],[a.createdAt,b.createdAt],[a.id,b.id]])if(x!==y)return x!<y!?-1:1;
  return 0;
};
export function buildV1Journal(input:unknown,filtersInput:unknown) {
  const inventory=V1JournalInputSchema.parse(input),filters=V1JournalFiltersSchema.parse(filtersInput),observations=inventory.observations;
  if(new Set(observations.map(r=>r.id)).size!==observations.length)throw Error('journal_duplicate_prediction');
  const rows:ReturnType<typeof V1JournalSummarySchema.parse>['rows']=observations.map(r=>{
    const v=r.verification,o=v?.outcome;
    if(v&&(v.predictionId!==r.id||!r.binding||v.matchId!==r.binding.matchId||o&&(!v.teamASide||o.matchId!==v.matchId||o.teamAId!==r.teamAId||o.teamBId!==r.teamBId)))
      throw Error('journal_verification_binding');
    if(v&&timeKey(v.checkedAt)>inventory.capturedAt||o&&timeKey(o.completedAt)>inventory.capturedAt)throw Error('journal_future_outcome');
    if(r.createdAt>inventory.capturedAt||r.issuedAt&&r.issuedAt>inventory.capturedAt)throw Error('journal_future_prediction');
    const favourite=r.probability===null||r.probability===0.5?null:r.probability>0.5?'A' as const:'B' as const;
    const base={predictionId:r.id,matchId:o?.matchId??null,primaryPredictionId:null as string|null,favourite,
      correct:o&&favourite!==null?(favourite==='A')===o.teamAWon:null};
    if(r.purpose!=='real_map')return {...base,status:'what_if' as const,reasons:['WHAT_IF_EXCLUDED']};
    if(r.status!=='done'||r.probability===null||r.issuedAt===null)return {...base,status:'unavailable' as const,reasons:r.attemptReasons};
    if(r.bindingConflict)return {...base,status:'unlinked' as const,reasons:['TARGET_BINDING_CONFLICT']};
    if(!r.binding)return {...base,status:r.latestOutcome?'unlinked' as const:'pending_verification' as const,reasons:['NO_VERIFIED_TARGET_BINDING']};
    if(!o||v?.status!=='linked')return {...base,status:'unlinked' as const,reasons:v?.reasons??['VERIFICATION_UNAVAILABLE']};
    const reasons=[...v.reasons];
    if(!r.eligibleModelAtIssuance||!r.modelId)reasons.push('MODEL_NOT_ELIGIBLE_AT_ISSUANCE');
    const start=timeKey(o.startedAt);
    if(r.createdAt>=start||r.issuedAt>=start||timeKey(r.cutoffAt)>start||r.issuedAt<r.createdAt)reasons.push('NOT_BEFORE_ACTUAL_START');
    if(!v.prospectiveEligible&&!reasons.length)reasons.push('NOT_PROSPECTIVE');
    return {...base,status:reasons.length?'excluded' as const:'primary' as const,reasons:[...new Set(reasons)]};
  });
  const primary=new Map<string,V1JournalObservation>();
  const truth=new Map<string,string>();
  for(let i=0;i<rows.length;i++) {
    const row=rows[i]!,r=observations[i]!;
    if(row.status!=='primary')continue;
    const v=r.verification!,o=v.outcome!;
    const signature=JSON.stringify([o.startedAt,o.completedAt,o.dataRevision,v.teamASide==='radiant'?o.teamAWon:!o.teamAWon]);
    if(truth.has(o.matchId)&&truth.get(o.matchId)!==signature)throw Error('journal_inconsistent_current_outcomes');
    truth.set(o.matchId,signature);
    const old=primary.get(o.matchId);if(!old||compare(r,old)>0)primary.set(o.matchId,r);
  }
  for(const row of rows)if(row.status==='primary') {
    row.primaryPredictionId=primary.get(row.matchId!)!.id;
    if(row.primaryPredictionId!==row.predictionId){row.status='superseded';row.reasons=['LATER_SUCCESSFUL_PRE_START_FORECAST'];}
  }
  // Select globally before model/time/status filters and before the matched-lineup cohort.
  const selected=rows.flatMap((row,i)=>{
    const r=observations[i]!;
    return (filters.modelId===null||r.modelId===filters.modelId)&&(!filters.fromAt||r.createdAt>=timeKey(filters.fromAt))&&
      (!filters.until||r.createdAt<timeKey(filters.until))&&(!filters.status||row.status===filters.status)?[{row,r}]:[];
  });
  const scored=selected.filter(x=>x.row.status==='primary');
  const metricRows=(items:typeof scored)=>items.map(({r})=>({probability:r.probability!,teamAWon:r.verification!.outcome!.teamAWon}));
  const count=(status:string)=>selected.filter(x=>x.row.status===status).length;
  return V1JournalSummarySchema.parse({primaryPolicy:'last_successful_pre_start_v1',metricPolicy:FORECAST_METRIC_POLICY,
    periodField:'forecast_created_at',logLossClip:FORECAST_LOG_LOSS_CLIP,filters,inventoryCount:observations.length,globalPrimaryMaps:primary.size,
    counts:{attempts:selected.length,realAttempts:selected.filter(x=>x.r.purpose==='real_map').length,whatIfAttempts:count('what_if'),
      issued:selected.filter(x=>x.r.purpose==='real_map'&&x.r.status==='done').length,unavailable:count('unavailable'),pendingVerification:count('pending_verification'),
      unlinked:count('unlinked'),excluded:count('excluded'),superseded:count('superseded'),primaryMaps:scored.length,
      verifiedMaps:new Set(selected.filter(x=>x.r.purpose==='real_map'&&x.r.verification?.status==='linked').map(x=>x.row.matchId)).size,cancelled:null},
    metrics:forecastMetrics(metricRows(scored)),matchedLineupMetrics:forecastMetrics(metricRows(scored.filter(x=>x.r.verification?.rosterStatus==='matched'))),
    rows:selected.map(x=>x.row),warnings:['CANCELLATION_STATUS_NOT_IMPLEMENTED','LOCAL_VERIFIED_OUTCOMES_ONLY','FILTERS_AFTER_GLOBAL_PRIMARY_SELECTION']});
}
