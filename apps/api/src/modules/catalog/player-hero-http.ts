import type {FastifyInstance} from 'fastify';
import {CatalogIdSchema,PlayerHeroQuerySchema,PlayerHeroResponseSchema} from '@dota/contracts';
import {PlayerHeroRepository,PlayerHeroQueryError} from '@dota/db';
export function registerPlayerHeroes(app:FastifyInstance,repository:PlayerHeroRepository){
  app.get<{Params:{id:string}}>('/api/v1/players/:id/heroes',async(request,reply)=>{
    const id=CatalogIdSchema.safeParse(request.params.id),query=PlayerHeroQuerySchema.safeParse(request.query);
    const invalid=()=>reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте игрока, героя, роль, патч и период UTC.',requestId:request.id}});
    if(!id.success||!query.success)return invalid();
    try{const result=await repository.report(id.data,query.data);
      if(result===null)return reply.code(404).send({error:{code:'NOT_FOUND',message:'Игрок не найден в локальной базе.',requestId:request.id}});
      return PlayerHeroResponseSchema.parse(result);
    }catch(error){if(error instanceof PlayerHeroQueryError)return invalid();throw error;}
  });
}
