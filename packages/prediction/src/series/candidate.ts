import {SeriesBestOfSchema,SeriesDiagnosticInputSchema,type SeriesBestOf} from '../../../contracts/dist/series/forecast.js';

export const SERIES_CANDIDATE_POLICY=Object.freeze({version:'iid-map-series-v1',targetUnit:'series',
 assumption:'constant_independent_map_probability',formats:[1,3,5] as const,
 featureBoundary:'before_series_start',validation:'not_evaluated',deployable:false});

/** Arithmetic baseline, not a publication gate. No averaging of predictions made between maps. */
export function seriesCandidateProbability(mapProbability:number,bestOf:SeriesBestOf):number{
 SeriesBestOfSchema.parse(bestOf);
 if(!Number.isFinite(mapProbability)||mapProbability<0||mapProbability>1)throw Error('invalid_map_probability');
 const p=mapProbability;
 if(bestOf===1)return p;
 if(bestOf===3)return p*p*(3-2*p);
 return p*p*p*(10+p*(-15+6*p));
}

/** Previously observed outcomes may be used for development diagnostics only. No quality pass is returned. */
export function evaluateSeriesDiagnostic(input:unknown){
 const rows=SeriesDiagnosticInputSchema.parse(input),groups=new Map<string,typeof rows>();
 if(new Set(rows.map(r=>r.forecastId)).size!==rows.length)throw Error('duplicate_forecast_id');
 const excluded:{seriesKey:string;reason:string}[]=[],selected:typeof rows=[];
 for(const r of rows){const group=groups.get(r.seriesKey)??[];group.push(r);groups.set(r.seriesKey,group);}
 for(const [seriesKey,group] of [...groups.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)){
  const signature=(r:typeof rows[number])=>JSON.stringify([r.bestOf,r.startedAt,r.endedAt,r.teamAWon,r.sourceSha256]);
  if(new Set(group.map(signature)).size!==1){excluded.push({seriesKey,reason:'SERIES_EVIDENCE_CONFLICT'});continue;}
  const usable=group.filter(r=>Date.parse(r.endedAt)>Date.parse(r.startedAt)&&
   Date.parse(r.baseIssuedAt)<Date.parse(r.startedAt)&&Date.parse(r.featureCutoffAt)<=Date.parse(r.baseIssuedAt));
  if(!usable.length){excluded.push({seriesKey,reason:'NO_PRE_SERIES_INPUT'});continue;}
  usable.sort((a,b)=>Date.parse(b.baseIssuedAt)-Date.parse(a.baseIssuedAt)||(a.forecastId<b.forecastId?-1:1));selected.push(usable[0]!);
 }
 const score=(probability:(r:typeof rows[number])=>number)=>{
  if(!selected.length)return {n:0,brier:null,logLoss:null};
  let brier=0,logLoss=0;
  for(const r of selected){const p=probability(r),y=Number(r.teamAWon);brier+=(p-y)**2;
   const clipped=Math.max(1e-15,Math.min(1-1e-15,p));logLoss-=y*Math.log(clipped)+(1-y)*Math.log(1-clipped);}
  return {n:selected.length,brier:brier/selected.length,logLoss:logLoss/selected.length};
 };
 return {format:'series-development-diagnostic-v1',targetUnit:'series',purpose:'development_only',deployable:false,
  qualityGate:'not_evaluated',independentValidation:false,inputRows:rows.length,uniqueSeries:groups.size,
  selectedForecastIds:selected.map(r=>r.forecastId),excluded,
  seriesCandidate:score(r=>seriesCandidateProbability(r.mapProbability,r.bestOf)),
  unchangedMapProbability:score(r=>r.mapProbability),constantBaseline:score(()=>.5),
  formats:([1,3,5] as const).map(bestOf=>({bestOf,n:selected.filter(r=>r.bestOf===bestOf).length}))};
}
