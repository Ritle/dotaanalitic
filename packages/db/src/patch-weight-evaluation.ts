import {PatchWeightEvaluationSchema,type PatchWeightEvaluationInput} from '@dota/contracts';
import {createHash} from 'node:crypto';
import {canonicalContextJson} from './temporal.js';
export type {PatchWeightEvaluationInput} from '@dota/contracts';
import {resolveHistoryWeights,type PatchMetaRegistry} from './patch-history.js';
const splits=['train','calibration','validation','test'] as const;
/** Offline descriptive-rate ablation; never trains, activates or publishes a model. */
export function evaluatePatchWeightPolicies(input:PatchWeightEvaluationInput,registry:PatchMetaRegistry){
  const q=PatchWeightEvaluationSchema.parse(input),maps=[...q.maps].sort((a,b)=>a.startedAt.localeCompare(b.startedAt)||(BigInt(a.matchId)<BigInt(b.matchId)?-1:1));
  if(new Set(maps.map(m=>m.matchId)).size!==maps.length||maps.some(m=>m.endedAt<=m.startedAt||m.labelKnownAt<m.endedAt))throw new Error('invalid_evaluation_maps');
  const series=new Map<string,string>();
  for(const m of maps){if(series.has(m.seriesId)&&series.get(m.seriesId)!==m.split)throw new Error('series_crosses_evaluation_split');series.set(m.seriesId,m.split);}
  for(let i=0;i<splits.length;i++){
    const current=maps.filter(m=>m.split===splits[i]);if(!current.length)throw new Error('missing_evaluation_split');
    const previous=maps.filter(m=>splits.indexOf(m.split)<i);
    if(previous.some(m=>m.startedAt>=current[0]!.startedAt||m.labelKnownAt>=current[0]!.startedAt))throw new Error('overlapping_evaluation_splits');
  }
  const firstValidation=maps.find(m=>m.split==='validation')!;
  if(q.policyFrozenAt>=firstValidation.startedAt)throw new Error('policy_not_frozen_before_validation');
  const scored:{matchId:string;split:'validation'|'test';coldStart:boolean|null;values:Record<'unweighted'|'time_only'|'time_patch_hero',number>;won:boolean}[]=[],excluded:{matchId:string;reasons:string[]}[]=[];
  for(const target of maps.filter(m=>m.split==='validation'||m.split==='test')){
    // No same-series labels, including earlier maps of the target's series.
    const history=maps.filter(m=>m.startedAt<target.startedAt&&m.labelKnownAt<target.startedAt&&m.seriesId!==target.seriesId);
    const report=resolveHistoryWeights({cutoffAt:target.startedAt,feature:q.feature,heroIds:q.heroIds,leagueId:q.leagueId,
      policy:q.policy,maps:history.map(({matchId,startedAt})=>({matchId,startedAt}))},registry);
    if(!history.length||report.status==='unavailable'){excluded.push({matchId:target.matchId,reasons:!history.length?['NO_EARLIER_LABELS']:[...new Set(report.maps.flatMap(m=>m.reasons)),'PATCH_METADATA_UNAVAILABLE']});continue;}
    const labels=new Map(history.map(m=>[m.matchId,m.won])),rate=(weights:number[])=>{
      const max=weights.reduce((a,b)=>Math.max(a,b),0),scaled=weights.map(w=>max?w/max:0),sum=scaled.reduce((a,b)=>a+b,0);
      return sum?scaled.reduce((a,w,i)=>a+(labels.get(report.maps[i]!.matchId)?w:0),0)/sum:null;
    };
    const time=rate(report.maps.map(m=>m.timeWeight!)),full=rate(report.maps.map(m=>m.weight!));
    if(time===null||full===null){excluded.push({matchId:target.matchId,reasons:['ZERO_EFFECTIVE_HISTORY']});continue;}
    scored.push({matchId:target.matchId,split:target.split as 'validation'|'test',coldStart:report.patchColdStart,won:target.won,
      values:{unweighted:history.filter(m=>m.won).length/history.length,time_only:time,time_patch_hero:full}});
  }
  const metrics=(rows:typeof scored,key:keyof (typeof scored)[number]['values'])=>{
    if(!rows.length)return {n:0,brier:null,logLoss:null,ece:null};
    let brier=0,logLoss=0;const bins=Array.from({length:10},()=>({n:0,p:0,y:0}));
    for(const r of rows){const p=r.values[key],y=Number(r.won),clipped=Math.min(1-1e-15,Math.max(1e-15,p));brier+=(p-y)**2;logLoss-=y*Math.log(clipped)+(1-y)*Math.log(1-clipped);
      const bin=bins[Math.min(9,Math.floor(p*10))]!;bin.n++;bin.p+=p;bin.y+=y;}
    return {n:rows.length,brier:brier/rows.length,logLoss:logLoss/rows.length,ece:bins.reduce((sum,b)=>sum+(b.n?Math.abs(b.p-b.y):0),0)/rows.length};
  };
  const summarize=(rows:typeof scored)=>Object.fromEntries((['unweighted','time_only','time_patch_hero'] as const).map(k=>[k,metrics(rows,k)]));
  const digest=(value:unknown)=>createHash('sha256').update(canonicalContextJson(value)).digest('hex');
  return {status:scored.length?'evaluated_candidate':'unavailable',origin:q.origin,datasetSha256:q.datasetSha256,inputSha256:digest(q),registrySnapshotSha256:digest(registry),codeRevision:q.codeRevision,
    cohortKey:q.cohortKey,policy:q.policy,policyFrozenAt:q.policyFrozenAt,registryRevision:registry.revision,
    validation:summarize(scored.filter(r=>r.split==='validation')),test:summarize(scored.filter(r=>r.split==='test')),
    patchColdStart:summarize(scored.filter(r=>r.coldStart)),scoredMapIds:scored.map(r=>r.matchId),excluded,
    coverage:{validationAndTestMaps:maps.filter(m=>m.split==='validation'||m.split==='test').length,scoredMaps:scored.length},
    deployable:false,modelQualityGate:'not_assessed',notes:['DESCRIPTIVE_RATE_ABLATION_NOT_MODEL_VALIDATION','NO_POLICY_SELECTION_ON_TEST','SAME_COHORT_ALL_ABLATIONS','ECE_10_BINS_LOG_CLIP_1E_MINUS15']};
}
