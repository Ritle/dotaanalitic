import type {FastifyInstance} from 'fastify';
import {CatalogIdSchema,StrengthQuerySchema,StrengthResponseSchema} from '@dota/contracts';
import {StrengthRepository,StrengthQueryError} from '@dota/db';
export function registerStrength(app:FastifyInstance,repository:StrengthRepository){
  app.get<{Params:{id:string}}>('/api/v1/teams/:id/strength',async(request,reply)=>{
    const id=CatalogIdSchema.safeParse(request.params.id),query=StrengthQuerySchema.safeParse(request.query);
    const invalid=()=>reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте ID организации, период UTC и число карт 20/50/100.',requestId:request.id}});
    if(!id.success||!query.success)return invalid();
    try{const result=await repository.report(id.data,query.data);
      if(result===null)return reply.code(404).send({error:{code:'NOT_FOUND',message:'Организация не найдена.',requestId:request.id}});
      return StrengthResponseSchema.parse(result);
    }catch(error){if(error instanceof StrengthQueryError)return invalid();throw error;}
  });
}
