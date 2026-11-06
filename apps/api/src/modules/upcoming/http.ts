import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {CatalogIdSchema,SchedulePageQuerySchema} from '@dota/contracts';
import {UpcomingService} from './service.js';
const Empty=z.object({}).strict();
export function registerUpcoming(app:FastifyInstance,service:UpcomingService){
  for(const method of ['GET','POST'] as const){
    const suffix=method==='POST'?'/refresh':'';
    app.route({method,url:'/api/v1/upcoming'+suffix,handler:async(req,reply)=>{
      const query=SchedulePageQuerySchema.safeParse(req.query);
      if(!query.success||method==='POST'&&!Empty.safeParse(req.body??{}).success)
        return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Некорректный запрос расписания.',requestId:req.id}});
      return service.schedule(method==='POST',query.data.page);
    }});
    app.route<{Params:{id:string}}>({method,url:'/api/v1/upcoming/tournaments/:id'+suffix,handler:async(req,reply)=>{
      const id=CatalogIdSchema.safeParse(req.params.id);
      if(!id.success||!Empty.safeParse(req.query).success||method==='POST'&&!Empty.safeParse(req.body??{}).success)
        return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Некорректный турнир.',requestId:req.id}});
      const data=await service.tournament(id.data,method==='POST');
      return data??reply.code(404).send({error:{code:'NOT_FOUND',message:'Турнир не найден в сохранённом расписании. Обновите список встреч.',requestId:req.id}});
    }});
  }
}
