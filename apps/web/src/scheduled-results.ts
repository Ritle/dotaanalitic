import {ownerAuth,AuthRequestError} from './auth';
import {queryClient} from './query-client';
import {PredictionRequestError} from './predictions';
export async function postScheduledResult<T>(path:string,schema:{parse(value:unknown):T},body:unknown,signal:AbortSignal):Promise<T>{
  let r:Response;
  try{r=await fetch('/api/v1/'+path,{method:'POST',credentials:'same-origin',cache:'no-store',signal,
    headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify(body)});}
  catch(e){if(signal.aborted)throw e;throw Error('Ответ не получен. Перечитайте сведения или повторите тот же запрос.');}
  if(r.status===401){ownerAuth.value=null;queryClient.clear();throw new AuthRequestError(401,'Сессия завершена. Войдите снова.');}
  if(!r.ok){const data=await r.json().catch(()=>null),code=typeof data?.error?.code==='string'?data.error.code:'';
    const lifecycle=path.endsWith('/lifecycle');
    const messages:Record<string,string>={schedule_result_map_unverified:'Карта не прошла проверку профессионального исхода, команд, турнира, серии и номера 1. Проверьте локальную историю и источник сопоставления.',
      schedule_result_already_bound:'У назначения уже есть неизменяемая связь. Перечитайте сохранённые сведения.',
      schedule_result_map_conflict:'Карта или серия уже сопоставлены иначе. Проверьте существующую связь.',
      lifecycle_future_event:'Дата события не может быть в будущем.',lifecycle_invalid_transition:'Состояние встречи не допускает это действие. Перечитайте историю.',
      lifecycle_request_conflict:'Этот запрос уже сохранён с другим содержимым.',
      forecast_schedule_binding_required:'Сначала сохраните сопоставление с проверенной картой.',CONFLICT:lifecycle?'История встречи изменилась. Перечитайте её перед новым действием.':'Редакция сверки изменилась. Перечитайте историю перед новым запросом.'};
    throw new PredictionRequestError(r.status,messages[code]??(r.status===409?'Запрос конфликтует с сохранёнными сведениями. Перечитайте их перед новым действием.':
      r.status===429?'Другая запись выполняется или превышен лимит. Повторите тот же запрос позже.':r.status===404?'Назначение, прогноз или связь не найдены.':
      r.status===403?'Проверка сессии устарела. Обновите страницу.':r.status===400?(lifecycle?'Проверьте дату события, ссылку, причину и подтверждение.':'Проверьте ID карты и серии, HTTPS-источник, объяснение и подтверждение.'):'Сервис не подтвердил запись. Можно безопасно повторить тот же запрос.'));
  }
  try{return schema.parse(await r.json());}catch{throw Error('Не удалось проверить сохранённый результат. Перечитайте сведения или повторите тот же запрос.');}
}
