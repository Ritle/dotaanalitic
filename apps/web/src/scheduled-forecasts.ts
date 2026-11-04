import {V1ScheduledPredictionViewSchema,type V1ScheduledPredictionCreate,type V1ScheduleTargetSaved,type ScenarioSnapshot} from '@dota/contracts';
import {ownerAuth,AuthRequestError} from './auth';
import {queryClient} from './query-client';
import {PredictionRequestError} from './predictions';
export function scheduledScenarioWarning(target:V1ScheduleTargetSaved,scenario:ScenarioSnapshot){
  const t=target.record,s=scenario.input,c=s.context;
  if(s.teamAId!==t.request.teamAId||s.teamBId!==t.request.teamBId)return 'Команды A/B сценария не совпадают с назначением. Проверьте порядок команд.';
  if(c.leagueId!==t.request.leagueId)return 'Турнир сценария не совпадает с назначением.';
  if(s.scheduledAt!==t.observation.match.scheduledAt)return 'Плановое начало сценария не совпадает с назначением.';
  if(c.mapNumber!==1||c.seriesId!==null||(c.teamASeriesWinsBefore??0)!==0||(c.teamBSeriesWinsBefore??0)!==0)return 'Для этой встречи выберите карту 1, без ID серии и без сыгранных карт.';
  return null;
}
export async function createScheduledForecast(targetId:string,body:V1ScheduledPredictionCreate,signal:AbortSignal){
  let r:Response;
  try{r=await fetch(`/api/v1/schedule-targets/${encodeURIComponent(targetId)}/forecasts`,{method:'POST',credentials:'same-origin',cache:'no-store',signal,
    headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify(body)});
  }catch(e){if(signal.aborted)throw e;throw Error('Ответ не получен. Проверьте историю или повторите тот же запрос.');}
  if(r.status===401){ownerAuth.value=null;queryClient.clear();throw new AuthRequestError(401,'Сессия завершена. Войдите снова.');}
  if(!r.ok){
    const messages:Record<string,string>={scheduled_target_revision_changed:'Появилась новая редакция назначения. Откройте её из расписания.',
      scheduled_target_source_changed:'Расписание изменилось. Проверьте и сохраните новую редакцию назначения.',
      scheduled_target_not_upcoming:'Встреча началась или её время и участники не подтверждены расписанием.',
      scheduled_target_scenario_mismatch:'Команды, турнир, время и карта 1 сценария должны совпадать с назначением.'};
    const data=await r.json().catch(()=>null),code=typeof data?.error?.code==='string'?data.error.code:'';
    throw new PredictionRequestError(r.status,messages[code]??(r.status===409?'Назначение или сценарий изменились. Обновите сохранённые сведения.':
      r.status===429?'Другой расчёт выполняется или превышен лимит. Повторите тот же запрос позже.':r.status===404?'Назначение или сценарий не найден.':
      r.status===403?'Проверка сессии устарела. Обновите страницу.':r.status===400?'Проверьте выбранный сценарий и сведения о турнире.':'Сервис не подтвердил сохранение. Можно безопасно повторить тот же запрос.'));
  }
  try{return V1ScheduledPredictionViewSchema.parse(await r.json());}catch{throw Error('Не удалось проверить ответ. Повторите тот же запрос или прочитайте историю.');}
}
