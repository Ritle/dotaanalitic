import {V1ScheduledBindingCreateSchema,V1ScheduledOutcomeRefreshSchema,V1ScheduledBindingViewSchema,V1ScheduledOutcomeViewSchema,V1ScheduledOutcomeHistorySchema} from '@dota/contracts';
import type {Db} from './index.js';
import {V1PredictionService} from './v1-prediction-reader.js';
import {V1ScheduleResultRepository} from './v1-schedule-result.js';
import {V1ForecastOutcomeRepository} from './v1-forecast-outcomes.js';
const bindingView=(saved:NonNullable<Awaited<ReturnType<V1ScheduleResultRepository['findForTarget']>>>)=>{
  const r=saved.record,q=r.request;
  return V1ScheduledBindingViewSchema.parse({requestId:q.requestId,sha256:saved.sha256,target:r.target,predictionRequestId:q.predictionRequestId,
    matchId:q.matchId,providerSeriesId:q.providerSeriesId,sourceUrl:q.sourceUrl,rationale:q.rationale,reviewedAt:r.reviewedAt,basis:r.basis});
};
export function scheduledOutcomeView(saved:Awaited<ReturnType<V1ForecastOutcomeRepository['refresh']>>){
  const {mapNumberEvidence:_,...result}=saved.result;return V1ScheduledOutcomeViewSchema.parse({...saved,result});
}
export class V1ScheduledResultService{
  private writing=false;
  private readonly bindings:V1ScheduleResultRepository;private readonly outcomes:V1ForecastOutcomeRepository;
  constructor(db:Db,private readonly predictions:V1PredictionService){this.bindings=new V1ScheduleResultRepository(db);this.outcomes=new V1ForecastOutcomeRepository(db);}
  async binding(owner:string,targetId:string,forecastId:string){
    await this.predictions.getScheduled(owner,targetId,forecastId);
    const saved=await this.bindings.findForTarget(owner,targetId);return {binding:saved?bindingView(saved):null};
  }
  async bind(owner:string,targetId:string,forecastId:string,input:unknown){
    if(this.writing)throw Error('scheduled_result_busy');this.writing=true;
    try{
      const {confirmedByOwner:_,...body}=V1ScheduledBindingCreateSchema.parse(input),forecast=await this.predictions.getScheduled(owner,targetId,forecastId);
      return bindingView(await this.bindings.bind(owner,{...body,predictionRequestId:forecast.requestId,targetSha256:forecast.target.targetSha256}));
    }finally{this.writing=false;}
  }
  async refresh(owner:string,targetId:string,forecastId:string,input:unknown){
    if(this.writing)throw Error('scheduled_result_busy');this.writing=true;
    try{
      const body=V1ScheduledOutcomeRefreshSchema.parse(input),forecast=await this.predictions.getScheduled(owner,targetId,forecastId);
      const binding=await this.bindings.findForTarget(owner,targetId);if(!binding)throw Error('forecast_schedule_binding_required');
      return scheduledOutcomeView(await this.outcomes.refresh(owner,{...body,predictionRequestId:forecast.requestId,matchId:binding.record.request.matchId}));
    }finally{this.writing=false;}
  }
  async history(owner:string,targetId:string,forecastId:string,beforeRevision:number|null=null){
    await this.predictions.getScheduled(owner,targetId,forecastId);
    const page=await this.outcomes.page(owner,forecastId,beforeRevision);
    return V1ScheduledOutcomeHistorySchema.parse({...page,items:page.items.map(scheduledOutcomeView)});
  }
}
