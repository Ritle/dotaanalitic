import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {CatalogIdSchema} from '@dota/contracts';
import {LiveEstimateHistorySchema,LiveEstimateRequestSchema} from './estimate-contract.js';
import type {LiveEstimateService} from './estimate-service.js';
import {QuickForecastError} from '../upcoming/quick-forecast.js';
export function registerLiveEstimates(app:FastifyInstance,service:LiveEstimateService){
 for(const method of ['GET','POST'] as const)app.route({method,url:'/api/v1/live/:id/estimates',config:{rateLimit:{max:method==='POST'?6:60,timeWindow:'1 minute'}},handler:async(req,reply)=>{
  reply.header('Cache-Control','no-store');
  try{
   z.object({}).strict().parse(req.query);const {id}=z.object({id:CatalogIdSchema}).strict().parse(req.params);
   return method==='GET'?LiveEstimateHistorySchema.parse(await service.history(req.ownerSession!.owner.id,id)):
    await service.run(req.ownerSession!.owner.id,id,LiveEstimateRequestSchema.parse(req.body));
  }catch(e){
   if(e instanceof z.ZodError)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте пятёрки и подтвердите условный характер оценки.',requestId:req.id}});
   if(e instanceof QuickForecastError)return reply.code(409).send({error:{code:e.code,message:e.message,leagueId:e.leagueId,requestId:req.id}});
   if(e instanceof Error&&e.message==='runtime_request_busy')return reply.header('Retry-After','1').code(429).send({error:{code:'CALCULATION_BUSY',message:'Расчёт уже выполняется. Повторите эту же попытку.',requestId:req.id}});
   throw e;
  }
 }});
}
