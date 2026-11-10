import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {CatalogIdSchema} from '@dota/contracts';
import {ActivityWriteSchema,TeamDirectoryQuerySchema} from './team-activity-contract.js';
import {TeamActivityRepository,TeamActivityError} from './team-activity-repository.js';
export function registerTeamActivity(app:FastifyInstance,repository:TeamActivityRepository){
 app.get('/api/v1/team-directory',async(req,reply)=>{const q=TeamDirectoryQuerySchema.safeParse(req.query);if(!q.success)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте фильтр команд.',requestId:req.id}});return repository.search(req.ownerSession!.owner.id,q.data);});
 for(const method of ['GET','POST'] as const)app.route<{Params:{id:string}}>({method,url:'/api/v1/teams/:id/activity',config:{rateLimit:{max:30,timeWindow:'1 minute'}},handler:async(req,reply)=>{
  const id=CatalogIdSchema.safeParse(req.params.id),body=ActivityWriteSchema.safeParse(req.body);
  if(!id.success||!z.object({}).strict().safeParse(req.query).success||method==='POST'&&!body.success)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте статус, источник и даты.',requestId:req.id}});
  try{return method==='POST'&&body.success?await repository.save(req.ownerSession!.owner.id,id.data,body.data):await repository.report(req.ownerSession!.owner.id,id.data);}
  catch(e){if(!(e instanceof TeamActivityError))throw e;const status=e.code==='not_found'?404:e.code==='conflict'?409:400;
   return reply.code(status).send({error:{code:e.code==='conflict'?'ACTIVITY_CONFLICT':e.code==='not_found'?'NOT_FOUND':'VALIDATION_ERROR',message:e.code==='conflict'?'Статус уже изменён. Перечитайте запись и проверьте новую редакцию.':e.code==='not_found'?'Команда не найдена.':'Дата проверки не может быть в будущем.',requestId:req.id}});}
 }});
}
