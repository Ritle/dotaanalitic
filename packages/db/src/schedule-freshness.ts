import {scheduleFreshnessReason,type V1ScheduleObservation} from '@dota/contracts';
import type {Db,Executor} from './index.js';
import {V1ScheduleTargetRepository} from './v1-schedule-target.js';
import {V1RuntimeRepository} from './v1-runtime-repository.js';

/** Additive admission boundary; the registered executor and immutable record formats stay pinned. */
export class FreshScheduleTargetRepository{
  private readonly repository:V1ScheduleTargetRepository;
  constructor(private readonly freshnessDb:Db){this.repository=new V1ScheduleTargetRepository(freshnessDb);}
  get(owner:string,id:string,db:Executor=this.freshnessDb){return this.repository.get(owner,id,db);}
  history(owner:string,matchId:string,beforeRevision:number|null=null){return this.repository.history(owner,matchId,beforeRevision);}
  create(owner:string,input:unknown){return this.repository.create(owner,input);}
  async preview(id:string,db:Executor=this.freshnessDb){
    const result=await this.repository.preview(id,db),reason=scheduleFreshnessReason(result.observation.fetchedAt,result.checkedAt);
    return {...result,eligible:result.eligible&&!reason,reasons:[...result.reasons,...(reason?[reason]:[])]};
  }
  async assertForecastFresh(owner:string,targetId:string,requestId:string){
    // Let the frozen executor validate and return an exact old request, including conflict handling.
    if(await new V1RuntimeRepository(this.freshnessDb).get(owner,requestId))return;
    const target=await this.get(owner,targetId),current=await this.preview(target.record.request.providerMatchId);
    assertScheduleFresh(current.observation,current.checkedAt);
  }
}
export function assertScheduleFresh(observation:V1ScheduleObservation,checkedAt:string){
  const reason=scheduleFreshnessReason(observation.fetchedAt,checkedAt);
  if(reason)throw Error(reason==='SCHEDULE_SOURCE_STALE'?'schedule_source_stale':'schedule_source_clock_invalid');
}
