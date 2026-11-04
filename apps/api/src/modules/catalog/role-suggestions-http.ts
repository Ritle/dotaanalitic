import type {FastifyInstance} from 'fastify';
import {RoleSuggestionRequestSchema,RoleSuggestionReportSchema} from '@dota/contracts';
import {RoleSuggestionRepository,RoleSuggestionQueryError} from '@dota/db';
export function registerRoleSuggestions(app:FastifyInstance,repository:RoleSuggestionRepository){
  app.post('/api/v1/lineup-role-suggestions',async(request,reply)=>{
    const input=RoleSuggestionRequestSchema.safeParse(request.body);
    const invalid=()=>reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Выберите до пяти разных игроков из каталога и срез не позднее текущего времени. Для большого периода уточните историю.',requestId:request.id}});
    if(!input.success)return invalid();
    try{return RoleSuggestionReportSchema.parse(await repository.suggest(input.data));}
    catch(e){if(e instanceof RoleSuggestionQueryError)return invalid();throw e;}
  });
}
