import {ownerAuth,AuthRequestError} from './auth';
import {queryClient} from './query-client';
export async function scheduleTargetCall<T>(path:string,schema:{parse(input:unknown):T},signal:AbortSignal,body?:unknown):Promise<T>{
  let r:Response;
  try{r=await fetch('/api/v1/'+path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',signal,
    ...(body?{headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify(body)}:{})});}
  catch(e){if(signal.aborted)throw e;throw Error('Ответ не получен. Повторите тот же запрос: сохранённая запись не продублируется.');}
  if(r.status===401){ownerAuth.value=null;queryClient.clear();throw new AuthRequestError(401,'Сессия завершена. Войдите снова.');}
  if(!r.ok)throw Object.assign(Error(r.status===409?'Источник или редакция изменились. Обновите сведения и проверьте выбор перед новым запросом.':
    r.status===404?'Назначение не найдено.':r.status===400?'Проверьте ID и сопоставление участников.':r.status===403?'Проверка сессии устарела. Обновите страницу.':
    r.status===429?'Слишком много запросов. Повторите позже.':'Источник или назначение не удалось проверить. Обновите расписание.'),{status:r.status});
  try{return schema.parse(await r.json());}catch{throw Error('Не удалось проверить ответ. Перечитайте сохранённые сведения.');}
}
