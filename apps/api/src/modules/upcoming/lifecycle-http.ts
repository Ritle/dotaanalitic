import {z} from 'zod';
import type {FastifyInstance,FastifyReply} from 'fastify';
import {V1ScheduledLifecycleCreateSchema,V1ScheduledLifecycleHistorySchema,V1ScheduledLifecycleViewSchema} from '@dota/contracts';
import {ScenarioError,type V1ScheduledLifecycleService} from '@dota/db';
const Params=z.object({targetId:z.uuid().transform(v=>v.toLowerCase())}).strict(),Empty=z.object({}).strict();
const Page=z.object({beforeRevision:z.coerce.number().int().positive().max(2147483647).optional()}).strict();
export function registerScheduledLifecycle(app:FastifyInstance,service:V1ScheduledLifecycleService){
  function failure(reply:FastifyReply,requestId:string,e:unknown){
    if(e instanceof z.ZodError)return reply.code(400).send({error:{code:'VALIDATION_ERROR',requestId,message:'Проверьте дату события в UTC, ссылку, причину и подтверждение действия.'}});
    const code=e instanceof ScenarioError?e.code:e instanceof Error?e.message:'';
    const messages:Record<string,string>={NOT_FOUND:'Назначение не найдено.',CONFLICT:'История встречи изменилась. Перечитайте её перед новым действием.',
      scheduled_lifecycle_busy:'Другая отметка ещё сохраняется. Повторите тот же запрос позже.',lifecycle_request_conflict:'Этот запрос уже сохранён с другим содержимым.',
      lifecycle_invalid_transition:'Сначала отметьте отмену; затем можно чередовать открытие и отмену.',lifecycle_future_event:'Дата события не может быть в будущем.',
      scheduled_lifecycle_integrity:'Не удалось проверить сохранённую историю встречи.'};
    if(!messages[code])throw e;
    const status=code==='NOT_FOUND'?404:code==='scheduled_lifecycle_busy'?429:code==='scheduled_lifecycle_integrity'?503:409;
    if(status===429)reply.header('Retry-After','1');return reply.code(status).send({error:{code,requestId,message:messages[code]}});
  }
  app.get('/api/v1/schedule-targets/:targetId/lifecycle',async(req,reply)=>{try{const p=Params.parse(req.params),q=Page.parse(req.query);
    return V1ScheduledLifecycleHistorySchema.parse(await service.history(req.ownerSession!.owner.id,p.targetId,q.beforeRevision));
  }catch(e){return failure(reply,req.id,e);}});
  app.post('/api/v1/schedule-targets/:targetId/lifecycle',{config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async(req,reply)=>{try{
    Empty.parse(req.query);const p=Params.parse(req.params),body=V1ScheduledLifecycleCreateSchema.parse(req.body);
    return V1ScheduledLifecycleViewSchema.parse(await service.append(req.ownerSession!.owner.id,p.targetId,body));
  }catch(e){return failure(reply,req.id,e);}});
}
