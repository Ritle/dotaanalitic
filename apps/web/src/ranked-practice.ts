import {RankedPracticeReportSchema,type RankedPracticeReport,type RankedProvider} from '@dota/contracts';
import {readCatalog,CatalogRequestError} from './catalog';
import {ownerAuth,AuthRequestError} from './auth';

export async function readRankedPractice(playerId:string,provider:RankedProvider,refresh:boolean,signal:AbortSignal):Promise<RankedPracticeReport>{
 try{
  const report=await readCatalog('ranked-practice',RankedPracticeReportSchema,signal,{method:'POST',
   headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify({playerId,provider,refresh})});
  if(report.playerId!==playerId||report.provider!==provider)throw Error('report_mismatch');
  return report;
 }catch(e){
  if(e instanceof AuthRequestError||e instanceof CatalogRequestError)throw e;
  throw Error('Не удалось прочитать рейтинговую историю. Повторите проверку.');
 }
}

export function rankedPracticeMessage(report:RankedPracticeReport):string{
 if(report.identityStatus==='conflict')return 'Связь игрока с аккаунтом неоднозначна. Проверьте аккаунт при подготовке состава.';
 if(report.identityStatus==='unknown')return 'Аккаунт игрока ещё не подтверждён. Проверьте его при подготовке состава.';
 if(report.reason==='disabled')return 'Загрузка рейтинговой истории сейчас отключена.';
 if(report.reason==='not_configured')return 'Этот источник не подключён. Можно выбрать другой источник.';
 if(report.status==='not_loaded')return 'Рейтинговая история ещё не загружена.';
 if(report.status==='empty')return 'Данные рейтинговых игр за период не получены.';
 if(report.status==='conflict')return 'В данных обнаружены противоречия. Спорные карты исключены.';
 if(report.stale)return 'Показаны сохранённые данные. Их нужно обновить.';
 if(report.status==='partial')return 'Показана часть доступной рейтинговой истории.';
 if(report.status==='ready')return 'Есть доступные рейтинговые карты.';
 return 'Рейтинговая история сейчас недоступна.';
}
export const rankedPracticeReason=(reason:string|null):string|null=>reason?({
 cooldown:'Источник просит подождать перед следующим обновлением.',refresh_in_progress:'Обновление источника уже выполняется. Проверьте результат позже.',
 source_rate_limited:'Достигнут лимит запросов источника.',request_budget_exhausted:'Лимит обращений к источнику исчерпан.',
 source_access_denied:'Источник ограничил доступ к истории.',source_http_error:'Источник временно не отвечает.',source_timeout:'Источник не ответил вовремя.',
 source_network_error:'Не удалось связаться с источником.',source_unavailable:'Источник временно недоступен.',
 source_player_unavailable:'Источник не предоставил историю этого аккаунта.',source_graphql_error:'Источник не смог вернуть историю.',
 source_schema_invalid:'Источник вернул данные неподдерживаемого формата.',source_invalid_json:'Источник вернул некорректный ответ.',
 source_invalid_payload:'Ответ источника не прошёл проверку.',source_id_mismatch:'Аккаунт в ответе источника не совпал с выбранным.',
 identity_changed:'Связь игрока с аккаунтом изменилась. Повторите проверку.',invalid_account:'Аккаунт не подходит для загрузки истории.'
 }[reason]??null):null;
export const rankedExclusionLabel=(reason:string):string=>({invalid_row:'неполные или некорректные записи',account_mismatch:'аккаунт не совпал',
 not_ranked_all_pick:'другой режим или тип лобби',league_conflict:'карты лиги',invalid_side:'сторона не подтверждена',outcome_conflict:'противоречивый исход',
 outside_window:'вне выбранного периода',not_completed_before_cutoff:'не завершены до среза',conflicting_map:'противоречивые карты',unknown_hero:'герой отсутствует в справочнике'}[reason]??'не прошли проверку');
