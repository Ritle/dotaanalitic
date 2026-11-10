import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {CatalogIdSchema} from '@dota/contracts';
import type {RosterContextService} from './roster-context-service.js';
export function registerRosterContext(app:FastifyInstance,service:RosterContextService){
 for(const kind of ['teams','players'] as const)for(const refresh of [false,true])app.route<{Params:{id:string}}>({
  method:refresh?'POST':'GET',url:`/api/v1/${kind}/:id/roster-context${refresh?'/refresh':''}`,config:{rateLimit:{max:30,timeWindow:'1 minute'}},
  handler:async(req,reply)=>{
   const id=CatalogIdSchema.safeParse(req.params.id);
   if(!id.success||!z.object({}).strict().safeParse(req.query).success||refresh&&!z.object({}).strict().safeParse(req.body).success)
    return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте выбранную карточку и параметры запроса.',requestId:req.id}});
   const result=await service.read(kind,id.data,refresh);
   return result??reply.code(404).send({error:{code:'NOT_FOUND',message:'Запись не найдена в локальном справочнике.',requestId:req.id}});
  }});
}
