import {z} from 'zod';
import {CatalogIdSchema} from '@dota/contracts';
import {SeriesForecastReadinessSchema,SeriesBestOfSchema} from '../../../../../packages/contracts/dist/series/forecast.js';
import {FreshPageScheduleTargetRepository,type Db} from '@dota/db';
import type {FastifyInstance} from 'fastify';

/** Separate target and gate: a map-model activation never authorizes series probabilities. */
export class SeriesReadinessService{
 private readonly targets:FreshPageScheduleTargetRepository;
 constructor(db:Db){this.targets=new FreshPageScheduleTargetRepository(db);}
 async read(id:string){
  const base={targetUnit:'series' as const,provider:'pandascore' as const,providerMatchId:CatalogIdSchema.parse(id),
   status:'unavailable' as const,teamAWinProbability:null,teamBWinProbability:null,modelVersion:null};
  try{
   const p=await this.targets.preview(id),m=p.observation.match;
   return SeriesForecastReadinessSchema.parse({...base,bestOf:m.seriesBestOf,scheduledAt:m.scheduledAt,checkedAt:p.checkedAt,
    sourceFetchedAt:p.observation.fetchedAt,sourceSha256:p.observation.snapshotSha256,
    reasons:[...p.reasons,...(!SeriesBestOfSchema.safeParse(m.seriesBestOf).success?[m.seriesBestOf===null?'SERIES_FORMAT_UNKNOWN':'SERIES_FORMAT_UNSUPPORTED']:[]),'SERIES_MODEL_NOT_VALIDATED']});
  }catch(e){
   if(!(e instanceof Error)||!['schedule_target_not_observed','schedule_target_history_limit'].includes(e.message))throw e;
   return SeriesForecastReadinessSchema.parse({...base,bestOf:null,scheduledAt:null,checkedAt:new Date().toISOString(),sourceFetchedAt:null,sourceSha256:null,
    reasons:['SERIES_SCHEDULE_UNAVAILABLE','SERIES_MODEL_NOT_VALIDATED']});
  }
 }
}
export function registerSeriesReadiness(app:FastifyInstance,service:SeriesReadinessService){
 app.get('/api/v1/upcoming/:id/series-forecast/readiness',async(req,reply)=>{
  const params=z.object({id:CatalogIdSchema}).strict().safeParse(req.params);
  if(!params.success||!z.object({}).strict().safeParse(req.query).success)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Некорректный запрос прогноза встречи.'}});
  try{return await service.read(params.data.id);}
  catch{return reply.code(503).send({error:{code:'SERIES_READINESS_UNAVAILABLE',message:'Не удалось проверить готовность прогноза встречи.'}});}
 });
}
