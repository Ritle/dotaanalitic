import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import type {LiveScheduleService} from './service.js';
const Empty=z.object({}).strict();
export function registerLiveSchedule(app:FastifyInstance,service:LiveScheduleService){
 for(const method of ['GET','POST'] as const)app.route({method,url:'/api/v1/live'+(method==='POST'?'/refresh':''),handler:async(req,reply)=>{
  if(!Empty.safeParse(req.query).success||method==='POST'&&!Empty.safeParse(req.body??{}).success)
   return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Некорректный запрос текущих матчей.',requestId:req.id}});
  return service.read(method==='POST');
 }});
}
