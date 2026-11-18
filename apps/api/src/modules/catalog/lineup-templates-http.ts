import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {CatalogIdSchema} from '@dota/contracts';
import {LineupTemplateWriteSchema} from './lineup-templates-contract.js';
import {LineupTemplateRepository,LineupTemplateError} from './lineup-templates-repository.js';
export function registerLineupTemplates(app:FastifyInstance,repository:LineupTemplateRepository){
 for(const method of ['GET','POST'] as const)app.route<{Params:{id:string}}>({method,url:'/api/v1/teams/:id/lineup-template',config:{rateLimit:{max:30,timeWindow:'1 minute'}},handler:async(req,reply)=>{
  if(method==='POST'&&req.ownerSession?.role!=='owner')return reply.code(403).send({error:{code:'OWNER_REQUIRED',message:'Только владелец может изменять пятёрки и роли.',requestId:req.id}});
  const id=CatalogIdSchema.safeParse(req.params.id),body=LineupTemplateWriteSchema.safeParse(req.body);
  if(!id.success||!z.object({}).strict().safeParse(req.query).success||method==='POST'&&!body.success)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Выберите пять разных игроков и роли 1–5.',requestId:req.id}});
  try{return method==='POST'&&body.success?await repository.save(req.ownerSession!.owner.id,id.data,body.data):await repository.report(id.data);}
  catch(e){if(!(e instanceof LineupTemplateError))throw e;const status={not_found:404,conflict:409,forbidden:403,invalid:400}[e.code];
   return reply.code(status).send({error:{code:e.code==='forbidden'?'OWNER_REQUIRED':e.code==='conflict'?'LINEUP_TEMPLATE_CONFLICT':e.code==='not_found'?'NOT_FOUND':'VALIDATION_ERROR',requestId:req.id,
    message:e.code==='forbidden'?'Только владелец может изменять пятёрки и роли.':e.code==='conflict'?'Шаблон уже изменён. Перечитайте его и подтвердите выбор заново.':e.code==='not_found'?'Команда не найдена.':'Игроки отсутствуют в локальном каталоге.'}});
  }
 }});
}
