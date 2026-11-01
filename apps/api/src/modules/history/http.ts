import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {CatalogIdSchema} from '@dota/contracts';
import type {HistoryRefreshService} from './service.js';
const Empty=z.object({}).strict();
export function registerHistoryRefresh(app:FastifyInstance,service:HistoryRefreshService){
  for(const method of ['GET','POST'] as const)app.route<{Params:{id:string}}>({method,url:'/api/v1/teams/:id/history-refresh',
    ...(method==='POST'?{config:{rateLimit:{max:20,timeWindow:'1 minute'}}}:{}),handler:async(req,reply)=>{
      const id=CatalogIdSchema.safeParse(req.params.id);
      if(!id.success||!Empty.safeParse(req.query).success||method==='POST'&&!Empty.safeParse(req.body??{}).success)
        return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Некорректный запрос обновления истории.',requestId:req.id}});
      try{
        const data=method==='POST'?await service.refresh(req.ownerSession!.owner.id,id.data):await service.read(req.ownerSession!.owner.id,id.data);
        return data?reply.code(method==='POST'?202:200).send(data):reply.code(404).send({error:{code:'NOT_FOUND',message:'Организация не найдена.',requestId:req.id}});
      }catch{return reply.code(503).send({error:{code:'HISTORY_QUEUE_UNAVAILABLE',message:'Обновление истории сейчас недоступно. Попробуйте позже.',requestId:req.id}});}
    }});
}
