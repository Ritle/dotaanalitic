import {V1ScheduledPredictionCreateSchema} from '@dota/contracts';
import type {Db} from './index.js';
import {V1PredictionService,scheduledPredictionView} from './v1-prediction-reader.js';
import {PageScheduledRuntimeRepository} from './schedule-page-runtime.js';
import {PageScheduleTargetRepository} from './schedule-page-targets.js';
import {readV1RuntimeCode} from './v1-runtime-code.js';

/** Reads old snapshots unchanged; only new scheduled requests use the page-aware binding. */
export class PageScheduledPredictionService {
  private calculating=false;
  private constructor(private readonly db:Db,private readonly reader:V1PredictionService,
    private readonly runtime:PageScheduledRuntimeRepository){}
  static async open(db:Db,reader:V1PredictionService){
    return new PageScheduledPredictionService(db,reader,new PageScheduledRuntimeRepository(db,await readV1RuntimeCode()));
  }
  getScheduled(owner:string,targetId:string,requestId:string){return this.reader.getScheduled(owner,targetId,requestId);}
  scheduledHistory(owner:string,targetId:string,offset:number){return this.reader.scheduledHistory(owner,targetId,offset);}
  get(owner:string,scenarioId:string,requestId:string){return this.reader.get(owner,scenarioId,requestId);}
  history(owner:string,scenarioId:string,offset:number){return this.reader.history(owner,scenarioId,offset);}
  async create(owner:string,request:unknown){
    if(this.calculating)throw Error('runtime_request_busy');this.calculating=true;
    try{return await this.reader.create(owner,request);}finally{this.calculating=false;}
  }
  async createScheduled(owner:string,targetId:string,input:unknown){
    if(this.calculating)throw Error('runtime_request_busy');this.calculating=true;
    try{
      const request=V1ScheduledPredictionCreateSchema.parse(input),target=await new PageScheduleTargetRepository(this.db).get(owner,targetId);
      if(target.sha256!==request.targetSha256)throw Error('scheduled_target_reference_mismatch');
      const {targetSha256,...rest}=request;
      return scheduledPredictionView(await this.runtime.create(owner,{...rest,purpose:'real_map',realTarget:{provider:'pandascore',bindingVersion:1,
        providerMatchId:target.record.request.providerMatchId,mapNumber:1,targetRequestId:target.record.request.requestId,targetSha256}}));
    }finally{this.calculating=false;}
  }
}
