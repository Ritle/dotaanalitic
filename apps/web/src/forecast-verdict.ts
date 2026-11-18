export type ForecastVerdictInput = {
  status: 'primary'|'superseded'|'eligible'|'what_if'|'unavailable'|'pending_verification'|'unlinked'|'excluded'|'cancelled';
  calculationStatus: 'done'|'unavailable';
  probability: number|null;
  actualWinner: 'A'|'B'|null;
  correct?: boolean|null;
  sourceChangedSinceRefresh?: boolean|null;
};
export function forecastVerdict(input: ForecastVerdictInput) {
  const state=(kind:string,label:string,detail:string,tone:'success'|'danger'|'warning'|'neutral'='neutral')=>({kind,label,detail,tone});
  if(input.status==='cancelled')return state('cancelled','Встреча отменена','Отметка владельца. Это не проигрыш прогноза.');
  if(input.calculationStatus!=='done'||input.probability===null)return state('unavailable','Прогноз не выдан','Оценивать правильность нечего: вероятность не была рассчитана.');
  if(input.status==='what_if')return state('what_if','Условный расчёт','Не оценивается как прогноз реальной карты.');
  if(input.sourceChangedSinceRefresh)return state('stale','Нужна повторная проверка','Источник результата изменился. Сохранённая сверка может быть устаревшей.','warning');
  if(input.status==='unlinked')return state('unlinked','Нужно связать с картой','Правильность пока не установлена: нет проверенной связи с результатом.','warning');
  if(input.status==='excluded')return state('excluded','Не оценивается','Запись исключена из статистики предматчевых прогнозов. Причина указана в сведениях.');
  if(input.status==='pending_verification'||input.actualWinner===null)return state('pending','Ожидает результата','Правильность пока неизвестна. Нужен проверенный результат этой карты.','warning');
  if(input.probability===0.5)return state('tie','Фаворит не выбран','Вероятности равны. Прогноз не считается ни верным, ни неверным.');
  const correct=(input.probability>0.5?'A':'B')===input.actualWinner;
  if(input.correct!==undefined&&input.correct!==correct)return state('inconsistent','Нужна повторная проверка','Сведения о прогнозе и результате не согласованы.','warning');
  const detail=input.status==='superseded'?'Предыдущий пересчёт: показан его результат, но в общей точности он не учитывается.':
    input.status==='primary'?'Основной прогноз: учитывается в точности. Проверен победитель одной карты.':
    'Победитель карты проверен. Основной прогноз для статистики выбирается в журнале.';
  return state(correct?'correct':'incorrect',correct?'Прогноз верен':'Прогноз неверен',detail,correct?'success':'danger');
}
