import {RankedContextReportSchema,type RankedContextReport} from '@dota/contracts';
import {readCatalog,CatalogRequestError} from './catalog';
import {ownerAuth,AuthRequestError} from './auth';
export async function readRankedContext(playerId:string,parentObservationId:string,refresh:boolean,signal:AbortSignal):Promise<RankedContextReport>{
 try{
  const report=await readCatalog('ranked-practice/context',RankedContextReportSchema,signal,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify({playerId,parentObservationId,refresh})});
  if(report.playerId!==playerId||report.parentObservationId!==parentObservationId)throw Error('context_mismatch');return report;
 }catch(e){if(e instanceof AuthRequestError||e instanceof CatalogRequestError)throw e;throw Error('Не удалось прочитать дополнение STRATZ. Повторите проверку.');}
}
export const rankedContextReason=(reason:string|null)=>reason?({
 disabled:'Дополнение рейтинговой истории сейчас отключено.',not_configured:'Для дополнения нужен подключённый STRATZ.',
 parent_changed:'Рейтинговая история изменилась. Повторно откройте её перед дополнением.',no_maps:'В этой истории нет карт для дополнения.',
 identity_unknown:'Аккаунт игрока ещё не подтверждён.',identity_conflict:'Связь игрока с аккаунтом неоднозначна.',identity_changed:'Связь игрока с аккаунтом изменилась. Проверьте его заново.',invalid_account:'Аккаунт не подходит для дополнения.',
 refresh_in_progress:'Дополнение уже выполняется. Проверьте сохранённый результат позже.',refresh_expired:'Время обновления истекло. Повторите проверку.',cooldown:'Источник просит подождать перед обновлением.',
 source_map_unavailable:'Карта не предоставлена источником.',source_rate_limited:'Достигнут лимит запросов STRATZ.',source_access_denied:'STRATZ ограничил доступ.',source_http_error:'STRATZ временно не отвечает.',source_network_error:'Не удалось связаться со STRATZ.',source_timeout:'STRATZ не ответил вовремя.',source_unavailable:'STRATZ временно недоступен.',
 source_graphql_error:'STRATZ не смог вернуть карты.',source_schema_invalid:'Источник вернул неподдерживаемый формат.',source_invalid_json:'Источник вернул некорректный ответ.',source_invalid_payload:'Ответ источника не прошёл проверку.',invalid_row:'Запись источника неполна или некорректна.',
 map_mismatch:'ID карты не совпал.',account_mismatch:'Аккаунт не совпал.',hero_mismatch:'Герой не совпал.',side_mismatch:'Сторона не совпала.',invalid_side:'Сторона источника не подтверждена.',outcome_conflict:'Исход не совпал.',time_mismatch:'Время карты не совпало.',not_ranked_all_pick:'Другой режим или тип лобби.',league_conflict:'Источник указал карту лиги.'
 }[reason]??'Данные не прошли проверку.'):null;
