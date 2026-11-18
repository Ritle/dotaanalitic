import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {CatalogIdSchema} from '@dota/contracts';
import {QuickForecastProgressStore} from './quick-forecast-progress.js';
import {QuickForecastRequestSchema,QuickForecastProgressResponseSchema} from './quick-forecast-contract.js';
import {QuickForecastError,type QuickForecastService} from './quick-forecast.js';
export function registerQuickForecast(app:FastifyInstance,service:QuickForecastService){
 const progress=new QuickForecastProgressStore();
 app.get('/api/v1/upcoming/:id/forecast-progress/:requestId',async(req,reply)=>{
  const params=z.object({id:CatalogIdSchema,requestId:z.uuid().transform(s=>s.toLowerCase())}).safeParse(req.params);
  if(!params.success||!z.object({}).strict().safeParse(req.query).success)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Некорректный запрос состояния расчёта.'}});
  reply.header('Cache-Control','no-store');
  return QuickForecastProgressResponseSchema.parse({progress:progress.get(req.ownerSession!.owner.id,params.data.id,params.data.requestId)});
 });
 app.post('/api/v1/upcoming/:id/forecast',{config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async(req,reply)=>{
  try{
   z.object({}).strict().parse(req.query);
   const {id}=z.object({id:CatalogIdSchema}).strict().parse(req.params);
   const body=QuickForecastRequestSchema.parse(req.body),owner=req.ownerSession!.owner.id;
   const status=progress.start(owner,id,body.requestId);
   try{const result=await service.run(owner,id,body,status.stage);status.finish(true);return result;}
   catch(e){status.finish(false);throw e;}
  }catch(e){
   if(e instanceof z.ZodError)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте две команды, десять игроков и роли.',requestId:req.id}});
   if(e instanceof QuickForecastError)return reply.code(e.code==='OWNER_REQUIRED'?403:409).send({error:{code:e.code,message:e.message,leagueId:e.leagueId,requestId:req.id}});
   const code=e instanceof Error?e.message:'';
   if(code==='runtime_request_busy')return reply.header('Retry-After','1').code(429).send({error:{code:'CALCULATION_BUSY',message:'Другой расчёт выполняется. Повторите эту попытку чуть позже.',requestId:req.id}});
   if(code.startsWith('schedule')||code==='CONFLICT'||code==='runtime_request_conflict')return reply.code(409).send({error:{code:'PREPARATION_CHANGED',message:'Расписание или сохранённая редакция изменились. Перечитайте встречу и начните новую попытку.',requestId:req.id}});
   throw e;
  }
 });
}
