import type {FastifyInstance} from 'fastify';
import {CatalogIdSchema,ProMapQuerySchema,ProMapResponseSchema} from '@dota/contracts';
import {ProMapRepository,ProMapQueryError} from '@dota/db';
export function registerProMaps(app:FastifyInstance,repository:ProMapRepository){
  for(const kind of ['teams','players'] as const)app.get<{Params:{id:string}}>('/api/v1/'+kind+'/:id/matches',async(request,reply)=>{
    const id=CatalogIdSchema.safeParse(request.params.id),query=ProMapQuerySchema.safeParse(request.query);
    const invalid=()=>reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте фильтры: время UTC, ID и роль выбранного игрока.',requestId:request.id}});
    if(!id.success||!query.success)return invalid();
    try{
      const result=await repository.report(kind,id.data,query.data);
      if(result===null)return reply.code(404).send({error:{code:'NOT_FOUND',message:'Запись не найдена в локальной базе.',requestId:request.id}});
      return ProMapResponseSchema.parse(result);
    }catch(error){if(error instanceof ProMapQueryError)return invalid();throw error;}
  });
}
