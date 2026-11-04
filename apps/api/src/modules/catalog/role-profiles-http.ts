import type {FastifyInstance} from 'fastify';
import {CatalogIdSchema,RoleProfilesRequestSchema,RoleProfileBindingWriteSchema} from '@dota/contracts';
import {RoleProfileQueryError,RoleSuggestionQueryError} from '@dota/db';
import {RoleProfileService} from './role-profile-service.js';
export function registerRoleProfiles(app:FastifyInstance,service:RoleProfileService){
  const invalid=(request:import('fastify').FastifyRequest,reply:import('fastify').FastifyReply,conflict=false)=>reply.code(conflict?409:400).send({error:{
    code:conflict?'REVISION_CONFLICT':'VALIDATION_ERROR',message:conflict?'Сопоставление уже изменено. Обновите страницу.':'Проверьте команду, игроков и сопоставление ID источников.',requestId:request.id}});
  app.post('/api/v1/lineup-role-profiles',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(request,reply)=>{
    const parsed=RoleProfilesRequestSchema.safeParse(request.body);if(!parsed.success)return invalid(request,reply);
    try{return await service.report(request.ownerSession!.owner.id,parsed.data);}catch(e){if(e instanceof RoleProfileQueryError||e instanceof RoleSuggestionQueryError)return invalid(request,reply);throw e;}
  });
  app.route<{Params:{id:string}}>({method:['GET','POST'],url:'/api/v1/teams/:id/role-profile-binding',handler:async(request,reply)=>{
    const id=CatalogIdSchema.safeParse(request.params.id),input=RoleProfileBindingWriteSchema.safeParse(request.body);
    if(!id.success||request.method==='POST'&&!input.success)return invalid(request,reply);
    try{return request.method==='POST'&&input.success?await service.repository.saveBinding(request.ownerSession!.owner.id,id.data,input.data):await service.repository.binding(request.ownerSession!.owner.id,id.data);}
    catch(e){if(e instanceof RoleProfileQueryError)return invalid(request,reply,e.code==='conflict');throw e;}
  }});
}
