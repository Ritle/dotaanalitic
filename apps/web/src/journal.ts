import {V1JournalViewSchema,V1JournalCodeChangedErrorSchema,type V1JournalCurrentFilters,type V1JournalView} from '@dota/contracts';
import {ownerAuth,AuthRequestError} from './auth';
import {queryClient} from './query-client';
import {predictionReason} from './predictions';
export class JournalRequestError extends Error{constructor(public readonly status:number,message:string){super(message);}}
async function call<T>(path:string,schema:{parse(v:unknown):T},signal:AbortSignal,body?:unknown){
  let response:Response;
  try{response=await fetch('/api/v1/forecast-journal'+path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',signal,
    ...(body?{headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify(body)}:{})});
  }catch(e){if(signal.aborted)throw e;throw new Error('Ответ не получен. Проверьте историю или безопасно повторите тот же запрос.');}
  if(response.status===401){ownerAuth.value=null;queryClient.clear();throw new AuthRequestError(401,'Сессия завершена. Войдите снова.');}
  if(response.status===503&&V1JournalCodeChangedErrorSchema.safeParse(await response.json().catch(()=>null)).success)
    throw new JournalRequestError(503,'Приложение обновлено. Перезапустите локальный сервер перед новым отчётом. Сохранённые версии доступны.');
  if(!response.ok)throw new JournalRequestError(response.status,response.status===409?'Запрос сохранён с другими фильтрами. Начните новый отчёт.':
    response.status===422?'Полный журнал превышает лимит отчёта. Частичная статистика не сформирована.':response.status===429?'Создание отчётов временно ограничено. Повторите тот же запрос позже.':
    response.status===403?'Проверка сессии устарела. Обновите страницу.':response.status===404?'Отчёт не найден.':response.status===400?'Проверьте период UTC, ID модели и статус.':
    'Сервис не подтвердил результат. Можно безопасно повторить запрос.');
  try{return schema.parse(await response.json());}catch{throw new Error('Не удалось проверить ответ журнала. Повторите запрос или обновите историю.');}
}
export const readJournal=<T>(path:string,schema:{parse(v:unknown):T},signal:AbortSignal)=>call(path,schema,signal);
export const createJournal=(body:{requestId:string;filters:V1JournalCurrentFilters},signal:AbortSignal):Promise<V1JournalView>=>call('',V1JournalViewSchema,signal,body);
export const journalStatus={primary:'Основной',superseded:'Предыдущий пересчёт',what_if:'Условный расчёт',unavailable:'Недоступен',
  pending_verification:'Ожидает проверки',unlinked:'Карта не привязана',excluded:'Исключён из метрик',cancelled:'Отменена · отметка владельца'};
const reasons:Record<string,string>={WHAT_IF_EXCLUDED:'Условный сценарий не входит в статистику реальных прогнозов.',
  OWNER_REPORTED_CANCELLATION:'Владелец отметил отмену встречи. Это не проигрыш прогноза и не подтверждённый результат карты.',
  CANCELLATION_IGNORED_VERIFIED_BINDING:'Для встречи уже подтверждена связь с сыгранной картой. Отметка отмены не исключает её из статистики.',
  LATER_SUCCESSFUL_PRE_START_FORECAST:'Для этой карты выбран более поздний успешный прогноз до старта.',
  NO_VERIFIED_TARGET_BINDING:'Нет проверенной связи с завершённой профессиональной картой.',
  SCHEDULE_BINDING_REQUIRED:'Для этой редакции встречи ещё не сохранено сопоставление с сыгранной картой.',
  SCHEDULE_BOUND_MAP_MISMATCH:'Указанная карта не совпадает с сохранённым сопоставлением встречи.',
  TARGET_BINDING_CONFLICT:'Одному назначению соответствуют разные карты; нужна проверка.',
  VERIFICATION_UNAVAILABLE:'Результат карты пока не удалось проверить.',MODEL_NOT_ELIGIBLE_AT_ISSUANCE:'Модель не имела допуска на момент выдачи.',
  NOT_BEFORE_ACTUAL_START:'Создание или выдача не предшествовали фактическому старту карты.',NOT_PROSPECTIVE:'Запись не является допустимым прогнозом до старта.',
  ACTUAL_MAP_OUTSIDE_TIER1_SCOPE:'Фактическое начало карты не попало в проверенную область турнира Tier 1.',
  MAP_NOT_FOUND:'Карта не найдена в локальной базе.',NO_ISSUED_PROBABILITY:'Вероятность не была выдана.',TARGET_LEAGUE_MISMATCH:'Лига карты не совпала с назначением.',
  TARGET_MAP_NUMBER_CONFLICT:'Источники расходятся в номере карты.',TARGET_MAP_NUMBER_UNVERIFIED:'Номер карты не подтверждён.',
  TARGET_SERIES_UNVERIFIED:'Связь с серией не подтверждена.',TARGET_TEAMS_MISMATCH:'Команды карты не совпали с назначением.'};
export const journalReason=(code:string)=>reasons[code]??predictionReason(code);
export const metricLabel=(n:number|null,percent=false)=>n===null?'—':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:percent?2:4,...(percent?{style:'percent'}:{})}).format(n);
export const rosterLabel=(status:string|null)=>status==='matched'?'Совпал':status==='mismatched'?'Не совпал':'Неизвестно';
