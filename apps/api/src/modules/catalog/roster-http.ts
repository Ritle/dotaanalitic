import type {FastifyInstance} from 'fastify';
import {CatalogIdSchema,RosterRequestSchema,RosterResponseSchema} from '@dota/contracts';
import {RosterRepository,RosterQueryError} from '@dota/db';
export function registerRoster(app:FastifyInstance,repository:RosterRepository){
  app.post<{Params:{id:string}}>('/api/v1/teams/:id/roster-cohesion',async(request,reply)=>{
    const id=CatalogIdSchema.safeParse(request.params.id),input=RosterRequestSchema.safeParse(request.body);
    const invalid=()=>reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте пятёрку: пять разных игроков из каталога, роли 1–5 и период UTC. Неизвестного игрока оставьте пустым.',requestId:request.id}});
    if(!id.success||!input.success)return invalid();
    try{const result=await repository.report(id.data,input.data);
      if(result===null)return reply.code(404).send({error:{code:'NOT_FOUND',message:'Организация не найдена.',requestId:request.id}});
      return RosterResponseSchema.parse(result);
    }catch(error){if(error instanceof RosterQueryError)return invalid();throw error;}
  });
}
