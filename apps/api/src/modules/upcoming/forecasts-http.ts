import {z} from 'zod';
import type {FastifyInstance,FastifyReply} from 'fastify';
import {V1ScheduledPredictionCreateSchema,V1ScheduledPredictionViewSchema,V1PredictionHistorySchema} from '@dota/contracts';
import {ScenarioError,type V1PredictionService,type FreshScheduleTargetRepository} from '@dota/db';
const Id=z.uuid().transform(v=>v.toLowerCase()),Params=z.object({targetId:Id}).strict(),Saved=Params.extend({requestId:Id});
const Paging=z.object({offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict(),Empty=z.object({}).strict();
export function registerScheduledForecasts(app:FastifyInstance,service:Pick<V1PredictionService,'createScheduled'|'getScheduled'|'scheduledHistory'>,freshness:Pick<FreshScheduleTargetRepository,'assertForecastFresh'>){
  function handle(reply:FastifyReply,requestId:string,error:unknown){
    const code=error instanceof ScenarioError?error.code:error instanceof Error?error.message:'';
    const messages:Record<string,string>={NOT_FOUND:'Назначение, сценарий или расчёт не найден.',CONFLICT:'Сценарий изменён. Загрузите сохранённую редакцию.',
      schedule_source_stale:'Сведения об этой встрече старше 5 минут. Обновите расписание перед новым прогнозом.',
      schedule_source_clock_invalid:'Время получения расписания некорректно. Обновите источник и проверьте часы сервера.',
      runtime_request_conflict:'Этот запрос уже сохранён с другим содержимым. Для новой попытки нужен новый запрос.',
      runtime_request_busy:'Другой расчёт ещё выполняется. Повторите запрос после его завершения.',
      scheduled_target_reference_mismatch:'Сохранённое назначение не совпало с запросом. Перечитайте эту редакцию.',
      scheduled_target_revision_changed:'Появилась новая редакция назначения. Откройте последнюю запись из расписания.',
      scheduled_target_not_upcoming:'Встреча началась или её начало и участники не подтверждены расписанием.',
      scheduled_target_source_changed:'Расписание изменилось. Сохраните проверенную новую редакцию назначения.',
      scheduled_target_scenario_mismatch:'Команды A/B, турнир, плановое начало и карта 1 сценария должны совпадать с назначением.',
      scheduled_target_clock_invalid:'Не удалось проверить время источника. Обновите расписание.',
      schedule_target_source_invalid:'Не удалось проверить сохранённый источник расписания.',schedule_target_history_limit:'Встреча отсутствует в последних наблюдениях. Обновите расписание.',
      schedule_target_not_observed:'Встреча не найдена в сохранённых наблюдениях. Обновите расписание.'};
    if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'VALIDATION_ERROR',requestId,message:'Проверьте сценарий, редакцию назначения и сведения о турнире.'}});
    if(!messages[code])throw error;
    const status=code==='NOT_FOUND'?404:code==='runtime_request_busy'?429:code.includes('invalid')&&code!=='schedule_source_clock_invalid'?503:409;
    if(status===429)reply.header('Retry-After','1');
    return reply.code(status).send({error:{code,requestId,message:messages[code]}});
  }
  const root='/api/v1/schedule-targets/:targetId/forecasts';
  app.post(root,{config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async(req,reply)=>{
    try{Empty.parse(req.query);const p=Params.parse(req.params),r=V1ScheduledPredictionCreateSchema.parse(req.body);
      await freshness.assertForecastFresh(req.ownerSession!.owner.id,p.targetId,r.requestId);
      return V1ScheduledPredictionViewSchema.parse(await service.createScheduled(req.ownerSession!.owner.id,p.targetId,r));
    }catch(e){return handle(reply,req.id,e);}
  });
  app.get(root,async(req,reply)=>{try{const p=Params.parse(req.params),q=Paging.parse(req.query);
    return V1PredictionHistorySchema.parse(await service.scheduledHistory(req.ownerSession!.owner.id,p.targetId,q.offset));
  }catch(e){return handle(reply,req.id,e);}});
  app.get(root+'/:requestId',async(req,reply)=>{try{Empty.parse(req.query);const p=Saved.parse(req.params);
    return V1ScheduledPredictionViewSchema.parse(await service.getScheduled(req.ownerSession!.owner.id,p.targetId,p.requestId));
  }catch(e){return handle(reply,req.id,e);}});
}
