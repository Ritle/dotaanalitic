import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {CatalogIdSchema,V1ScheduleTargetRequestSchema} from '@dota/contracts';
import {ScenarioError,type V1ScheduleTargetRepository} from '@dota/db';
const Id=z.object({id:CatalogIdSchema}).strict(),Request=z.object({requestId:z.uuid()}).strict();
const Page=z.object({beforeRevision:z.coerce.number().int().positive().max(2147483647).optional()}).strict(),Empty=z.object({}).strict();
export function registerScheduleTargets(app:FastifyInstance,repo:V1ScheduleTargetRepository){
  const messages:Record<string,string>={schedule_target_source_changed:'Расписание изменилось. Перечитайте источник и проверьте сопоставление команд.',
    schedule_target_not_upcoming:'Нельзя сохранить новое назначение: встреча уже началась, не имеет времени начала или полных участников.',
    schedule_target_mapping:'Сопоставьте двух разных участников источника с двумя разными локальными командами.',
    schedule_target_catalog_missing:'Выбранная команда или турнир отсутствует в локальном справочнике.',
    schedule_target_request_conflict:'Этот запрос уже сохранён с другим содержимым. Для изменения нужен новый запрос.',
    schedule_target_not_observed:'Встреча не найдена в сохранённых наблюдениях. Обновите расписание.',
    schedule_target_history_limit:'Встреча не найдена в последних 200 наблюдениях. Полнота поиска не подтверждена.',
    schedule_target_source_invalid:'Не удалось проверить сохранённый источник. Обновите расписание.',schedule_target_integrity:'Не удалось проверить сохранённое назначение.'};
  async function guarded(fn:()=>Promise<unknown>){try{return await fn();}catch(e){
    if(e instanceof ScenarioError)throw Object.assign(new Error(e.code==='NOT_FOUND'?'Запись не найдена.':'Редакция изменена. Перечитайте историю.'),{targetCode:e.code,targetStatus:e.code==='NOT_FOUND'?404:409});
    if(e instanceof Error&&messages[e.message])throw Object.assign(new Error(messages[e.message]),{targetCode:e.message,targetStatus:e.message.includes('integrity')||e.message.includes('invalid')?503:409});throw e;}}
  const route=(method:'GET'|'POST',url:string,run:(req:import('fastify').FastifyRequest)=>Promise<unknown>)=>app.route({method,url,
    ...(method==='POST'?{config:{rateLimit:{max:12,timeWindow:'1 minute'}}}:{}),handler:async(req,reply)=>{
      try{return await guarded(()=>run(req));}catch(e){
        if(e instanceof z.ZodError)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Проверьте назначение первой карты и сопоставление участников.',requestId:req.id}});
        if(e instanceof Error&&'targetStatus' in e&&'targetCode' in e)return reply.code(e.targetStatus as number).send({error:{code:e.targetCode,message:e.message,requestId:req.id}});
        throw e;}
    }});
  route('GET','/api/v1/upcoming/:id/target-preview',async req=>{Empty.parse(req.query);return repo.preview(Id.parse(req.params).id);});
  route('GET','/api/v1/upcoming/:id/targets',async req=>repo.history(req.ownerSession!.owner.id,Id.parse(req.params).id,Page.parse(req.query).beforeRevision??null));
  route('POST','/api/v1/schedule-targets',async req=>{Empty.parse(req.query);return repo.create(req.ownerSession!.owner.id,V1ScheduleTargetRequestSchema.parse(req.body));});
  route('GET','/api/v1/schedule-targets/:requestId',async req=>{Empty.parse(req.query);return repo.get(req.ownerSession!.owner.id,Request.parse(req.params).requestId);});
}
