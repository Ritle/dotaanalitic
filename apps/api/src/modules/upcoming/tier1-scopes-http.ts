import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {Tier1ScopeQuerySchema,Tier1ScopeWriteSchema} from '@dota/contracts';
import {ScenarioError,type Tier1ScopeRepository} from '@dota/db';
export function registerTier1Scopes(app:FastifyInstance,repo:Tier1ScopeRepository){
 const messages:Record<string,string>={tier1_scope_request_conflict:'Этот запрос уже сохранён с другим содержимым. Перечитайте список.',
  tier1_scope_integrity:'Не удалось проверить сохранённое событие.',tier1_scope_new_league:'Для другого ID OpenDota сохраните отдельное событие.'};
 function failure(e:unknown,reply:import('fastify').FastifyReply,id:string){
  if(e instanceof z.ZodError)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте ID OpenDota, период UTC, HTTPS-источник и обоснование события Tier 1.',requestId:id}});
  if(e instanceof ScenarioError)return reply.code(409).send({error:{code:e.code,message:'Запись изменилась. Перечитайте список перед сохранением.',requestId:id}});
  if(e instanceof Error&&messages[e.message])return reply.code(e.message==='tier1_scope_integrity'?503:409).send({error:{code:e.message,message:messages[e.message],requestId:id}});
  throw e;
 }
 app.get('/api/v1/tier1-scopes',async(req,reply)=>{try{return await repo.list(req.ownerSession!.owner.id,Tier1ScopeQuerySchema.parse(req.query));}catch(e){return failure(e,reply,req.id);}});
 app.post('/api/v1/tier1-scopes',{config:{rateLimit:{max:12,timeWindow:'1 minute'}}},async(req,reply)=>{
  try{z.object({}).strict().parse(req.query);return await repo.write(req.ownerSession!.owner.id,Tier1ScopeWriteSchema.parse(req.body));}catch(e){return failure(e,reply,req.id);}
 });
}
