import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import type {JournalResultService} from './journal-result-service.js';
export function registerJournalResults(app:FastifyInstance,service:JournalResultService){
 app.post('/api/v1/forecast-journal/results/:requestId/refresh',{config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async(req,reply)=>{
  const p=z.object({requestId:z.uuid()}).strict().safeParse(req.params);
  if(!p.success||!z.object({}).strict().safeParse(req.query).success||!z.object({}).strict().safeParse(req.body))return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Некорректный запрос сверки.'}});
  try{return await service.read(req.ownerSession!.owner.id,p.data.requestId,true);}
  catch(e){const missing=e instanceof Error&&e.message==='result_lookup_not_found';return reply.code(missing?404:503).send({error:{code:missing?'NOT_FOUND':'RESULT_UNAVAILABLE',message:'Не удалось повторно сверить результат.'}});}
 });
 app.get('/api/v1/forecast-journal/results/:requestId',async(req,reply)=>{
  const p=z.object({requestId:z.uuid()}).strict().safeParse(req.params);
  if(!p.success||!z.object({}).strict().safeParse(req.query).success)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Некорректный запрос результата.',requestId:req.id}});
  try{return await service.read(req.ownerSession!.owner.id,p.data.requestId);}
  catch(e){const notFound=e instanceof Error&&e.message==='result_lookup_not_found';return reply.code(notFound?404:503).send({error:{code:notFound?'NOT_FOUND':'RESULT_UNAVAILABLE',message:notFound?'Прогноз не найден.':'Не удалось проверить результат. Повторите позже.',requestId:req.id}});}
 });
}
