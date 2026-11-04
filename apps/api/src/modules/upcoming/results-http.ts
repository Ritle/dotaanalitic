import {z} from 'zod';
import type {FastifyInstance,FastifyReply} from 'fastify';
import {V1ScheduledBindingCreateSchema,V1ScheduledBindingViewSchema,V1ScheduledBindingStateSchema,V1ScheduledOutcomeRefreshSchema,V1ScheduledOutcomeViewSchema,V1ScheduledOutcomeHistorySchema} from '@dota/contracts';
import {ScenarioError,type V1ScheduledResultService} from '@dota/db';
const Id=z.uuid().transform(v=>v.toLowerCase()),Params=z.object({targetId:Id,forecastId:Id}).strict(),Empty=z.object({}).strict();
const Page=z.object({beforeRevision:z.coerce.number().int().positive().max(2147483647).optional()}).strict();
export function registerScheduledResults(app:FastifyInstance,service:V1ScheduledResultService){
  const root='/api/v1/schedule-targets/:targetId/forecasts/:forecastId';
  function failure(reply:FastifyReply,requestId:string,e:unknown){
    if(e instanceof z.ZodError)return reply.code(400).send({error:{code:'VALIDATION_ERROR',requestId,message:'Проверьте ID карты и серии, HTTPS-источник, объяснение и подтверждение сопоставления.'}});
    const code=e instanceof ScenarioError?e.code:e instanceof Error?e.message:'';
    const messages:Record<string,string>={NOT_FOUND:'Назначение, прогноз или связь не найдены.',CONFLICT:'Редакция сверки изменилась. Перечитайте историю перед новой проверкой.',
      scheduled_result_busy:'Другая запись результата ещё выполняется. Повторите тот же запрос позже.',
      schedule_result_request_conflict:'Этот запрос уже сохранён с другим содержимым. Для другого действия нужен новый запрос.',
      forecast_request_conflict:'Этот запрос сверки уже сохранён с другим содержимым.',
      schedule_result_target_mismatch:'Связь не соответствует исходному назначению прогноза.',schedule_result_target_required:'Выберите прогноз для сохранённой встречи расписания.',
      schedule_result_map_unverified:'Карта не прошла проверку профессионального исхода, команд, турнира, серии и номера 1. Проверьте импортированные данные и источник сопоставления.',
      schedule_result_already_bound:'У этой редакции назначения уже есть неизменяемая связь. Перечитайте сохранённые сведения.',
      schedule_result_map_conflict:'Карта или серия уже сопоставлены с другим назначением. Требуется проверка существующей связи.',
      forecast_schedule_binding_required:'Сначала сохраните проверенное сопоставление с картой.',forecast_bound_map_conflict:'Прогноз уже связан с другой картой.',
      schedule_result_integrity:'Не удалось проверить сохранённую связь.',forecast_outcome_integrity:'Не удалось проверить сохранённую сверку.'};
    if(!messages[code])throw e;
    const status=code==='NOT_FOUND'?404:code==='scheduled_result_busy'?429:code.includes('integrity')?503:409;
    if(status===429)reply.header('Retry-After','1');return reply.code(status).send({error:{code,requestId,message:messages[code]}});
  }
  app.get(root+'/result-binding',async(req,reply)=>{try{Empty.parse(req.query);const p=Params.parse(req.params);
    return V1ScheduledBindingStateSchema.parse(await service.binding(req.ownerSession!.owner.id,p.targetId,p.forecastId));
  }catch(e){return failure(reply,req.id,e);}});
  app.post(root+'/result-binding',{config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async(req,reply)=>{try{Empty.parse(req.query);const p=Params.parse(req.params),body=V1ScheduledBindingCreateSchema.parse(req.body);
    return V1ScheduledBindingViewSchema.parse(await service.bind(req.ownerSession!.owner.id,p.targetId,p.forecastId,body));
  }catch(e){return failure(reply,req.id,e);}});
  app.get(root+'/outcomes',async(req,reply)=>{try{const p=Params.parse(req.params),q=Page.parse(req.query);
    return V1ScheduledOutcomeHistorySchema.parse(await service.history(req.ownerSession!.owner.id,p.targetId,p.forecastId,q.beforeRevision??null));
  }catch(e){return failure(reply,req.id,e);}});
  app.post(root+'/outcomes',{config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async(req,reply)=>{try{Empty.parse(req.query);const p=Params.parse(req.params),body=V1ScheduledOutcomeRefreshSchema.parse(req.body);
    return V1ScheduledOutcomeViewSchema.parse(await service.refresh(req.ownerSession!.owner.id,p.targetId,p.forecastId,body));
  }catch(e){return failure(reply,req.id,e);}});
}
