import type {FastifyInstance} from 'fastify';
import {CompareRequestSchema,CompareResponseSchema} from '@dota/contracts';
import {CompareRepository,CompareQueryError} from '@dota/db';
export function registerCompare(app:FastifyInstance,repository:CompareRepository){
  app.post('/api/v1/teams/compare',async(request,reply)=>{
    const parsed=CompareRequestSchema.safeParse(request.body);
    const invalid=()=>reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Выберите две разные команды, разных игроков из каталога и корректный период UTC.',requestId:request.id}});
    if(!parsed.success)return invalid();
    try{const report=await repository.report(parsed.data);
      if(report===null)return reply.code(404).send({error:{code:'NOT_FOUND',message:'Одна из организаций не найдена.',requestId:request.id}});
      return CompareResponseSchema.parse(report);
    }catch(e){if(e instanceof CompareQueryError)return invalid();throw e;}
  });
}
