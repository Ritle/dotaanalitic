<script setup lang="ts">
import {computed,reactive,ref,watch,onBeforeUnmount} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {V1JournalViewSchema,V1JournalHistorySchema,V1JournalCurrentRequestSchema,V1JournalCurrentStatusSchema,type V1JournalCurrentFilters} from '@dota/contracts';
import {createJournal,readJournal,JournalRequestError,journalStatus,journalReason,metricLabel,rosterLabel} from '../journal';
import {dateLabel} from '../catalog';
const route=useRoute(),router=useRouter(),cache=useQueryClient();
const selectedId=computed(()=>typeof route.query.report==='string'?route.query.report:'');
const cursors=ref<(number|null)[]>([null]),before=computed(()=>cursors.value.at(-1)??null),offset=ref(0),busy=ref(false),error=ref('');
const pending=ref<{requestId:string;filters:V1JournalCurrentFilters}|null>(null),conflict=ref(false);
const form=reactive({fromAt:'',until:'',modelId:'',status:''});let controller:AbortController|null=null;
const history=useQuery({queryKey:computed(()=>['forecast-journal-history',before.value]),queryFn:({signal})=>
  readJournal(before.value===null?'':`?beforeRevision=${before.value}`,V1JournalHistorySchema,signal)});
const saved=useQuery({queryKey:computed(()=>['forecast-journal',selectedId.value,offset.value]),enabled:computed(()=>!!selectedId.value&&!busy.value),
  queryFn:({signal})=>readJournal(`/${encodeURIComponent(selectedId.value)}?offset=${offset.value}`,V1JournalViewSchema,signal)});
const selected=computed(()=>saved.data.value?.requestId===selectedId.value?saved.data.value:null);
watch(selectedId,()=>{offset.value=0;});
watch(selected,v=>{if(v&&pending.value?.requestId===v.requestId){pending.value=null;error.value='';void cache.invalidateQueries({queryKey:['forecast-journal-history']});}});
onBeforeUnmount(()=>controller?.abort());
async function submit(retry=false){
  if(busy.value)return;error.value='';conflict.value=false;let body=retry?pending.value:null;
  if(!body)try{body=V1JournalCurrentRequestSchema.parse({requestId:crypto.randomUUID(),filters:{
    fromAt:form.fromAt?new Date(form.fromAt+'Z').toISOString():null,until:form.until?new Date(form.until+'Z').toISOString():null,
    modelId:form.modelId.trim()||null,status:form.status||null}});
  }catch{error.value='Проверьте период UTC: начало раньше конца; ID модели должен быть UUID.';return;}
  const active=new AbortController();controller=active;pending.value=body;busy.value=true;offset.value=0;
  try{
    await router.replace({query:{report:body.requestId}});
    const result=await createJournal(body,active.signal);if(active.signal.aborted)return;
    cache.setQueryData(['forecast-journal',result.requestId,0],result);pending.value=null;cursors.value=[null];
    await cache.invalidateQueries({queryKey:['forecast-journal-history']});
  }catch(e){if(active.signal.aborted)return;error.value=e instanceof Error?e.message:'Ответ не получен. Повторите тот же запрос.';
    conflict.value=e instanceof JournalRequestError&&e.status===409;
  }finally{if(controller===active)busy.value=false;}
}
async function refresh(){error.value='';await history.refetch();if(selectedId.value)await saved.refetch();}
</script>
<template>
  <main class="journal-page">
    <RouterLink to="/">← Личный кабинет</RouterLink>
    <h1>Журнал прогнозов</h1>
    <p>Статистика собственных предматчевых прогнозов одной карты и проверенных профессиональных результатов.</p>
    <section class="panel" aria-label="Новый отчёт журнала">
      <h2>Создать отчёт</h2>
      <p>Каждая версия сохраняет статистику на момент проверки. Фильтры ниже относятся к новому отчёту.</p>
      <p class="hint">Проверяются уже привязанные локальные карты. Поиск и первичная привязка новых результатов выполняются отдельно.</p>
      <form @submit.prevent="submit()">
        <fieldset :disabled="busy"><legend>Фильтры нового отчёта</legend>
          <div class="filter-grid">
            <label>Создан с · UTC<input v-model="form.fromAt" type="datetime-local" /></label>
            <label>Создан до · UTC, не включая<input v-model="form.until" type="datetime-local" /></label>
            <label>ID модели · UUID<input v-model="form.modelId" placeholder="Все модели" /></label>
            <div class="filter-control"><label for="journal-status">Статус</label><select id="journal-status" v-model="form.status"><option value="">Все статусы</option><option v-for="s in V1JournalCurrentStatusSchema.options" :key="s" :value="s">{{ journalStatus[s] }}</option></select></div>
          </div>
          <p class="hint">Основной прогноз выбирается по всему журналу до фильтрации. Ранний пересчёт не заменяет основной после выбора периода или модели.</p>
          <button type="submit">{{ busy?'Создание отчёта…':'Создать и сохранить отчёт' }}</button>
        </fieldset>
      </form>
      <p v-if="busy" role="status">Проверяем локальные исходы и сохраняем отчёт…</p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <button v-if="pending&&!busy&&!conflict" @click="submit(true)">Повторить тот же запрос</button>
      <button :disabled="busy" @click="refresh">Обновить историю</button>
    </section>
    <section class="panel" aria-label="История отчётов">
      <h2>История отчётов</h2>
      <p v-if="history.isFetching.value" role="status">Загрузка истории…</p>
      <p v-if="history.error.value" role="alert" class="error">{{ history.error.value.message }}</p>
      <p v-if="history.data.value&&!history.data.value.items.length">Сохранённых отчётов пока нет.</p>
      <ul><li v-for="item in history.data.value?.items" :key="item.requestId"><RouterLink :to="{query:{report:item.requestId}}" :aria-current="selectedId===item.requestId?'page':undefined">
        Версия {{ item.revision }} · {{ dateLabel(item.capturedAt) }} · N={{ item.n }} · accuracy {{ metricLabel(item.accuracy,true) }}
      </RouterLink></li></ul>
      <div class="pagination"><button v-if="cursors.length>1" @click="cursors=cursors.slice(0,-1)">Новые отчёты</button>
        <button v-if="history.data.value?.nextBeforeRevision" @click="cursors=[...cursors,history.data.value.nextBeforeRevision]">Ранние отчёты</button></div>
    </section>
    <p v-if="selectedId&&saved.isFetching.value&&!busy" role="status">Загрузка сохранённого отчёта…</p>
    <p v-if="selectedId&&saved.error.value&&!busy&&!pending" role="alert" class="error">{{ saved.error.value.message }}</p>
    <article v-if="selected" class="panel" aria-label="Сохранённый отчёт журнала">
      <h2>Отчёт · версия {{ selected.revision }}</h2>
      <p>Проверено: {{ dateLabel(selected.capturedAt) }}. Последующие изменения результатов не переписывают эту версию.</p>
      <p>Период создания прогноза: {{ selected.summary.filters.fromAt?dateLabel(selected.summary.filters.fromAt):'без нижней границы' }} — {{ selected.summary.filters.until?dateLabel(selected.summary.filters.until):'без верхней границы' }} (конец не включён).</p>
      <p>Модель: {{ selected.summary.filters.modelId??'все' }}. Статус: {{ selected.summary.filters.status?journalStatus[selected.summary.filters.status]:'все' }}.</p>
      <p class="hint">Учтены только локально проверенные исходы. Полнота внешней истории неизвестна. Несовпадения и неизвестные составы остаются в общей статистике.</p>
      <div class="summary-grid" aria-label="Счётчики журнала">
        <p><strong>{{ selected.summary.counts.attempts }}</strong><span>Попыток после фильтров</span></p>
        <p><strong>{{ selected.summary.counts.issued }}</strong><span>Выданных реальных прогнозов</span></p>
        <p><strong>{{ selected.summary.counts.primaryMaps }}</strong><span>Основных прогнозов / карт</span></p>
        <p><strong>{{ selected.summary.counts.verifiedMaps }}</strong><span>Карт с проверенным исходом</span></p>
        <p><strong>{{ selected.summary.counts.pendingVerification }}</strong><span>Ожидают проверки</span></p>
        <p><strong>{{ selected.summary.counts.unlinked }}</strong><span>Без связи с картой</span></p>
        <p><strong>{{ selected.summary.counts.unavailable }}</strong><span>Недоступных реальных попыток</span></p>
        <p><strong>{{ selected.summary.counts.excluded }}</strong><span>Исключены из метрик</span></p>
        <p><strong>{{ selected.summary.counts.superseded }}</strong><span>Предыдущих пересчётов</span></p>
        <p><strong>{{ selected.summary.counts.whatIfAttempts }}</strong><span>Условных расчётов</span></p>
      </div>
      <p v-if="selected.summary.counts.cancelled===null" class="warning">Этот архивный отчёт создан до подключения учёта отмен: число отмен неизвестно.</p>
      <p v-else>Отменённых назначений карты: <strong>{{ selected.summary.counts.cancelled }}</strong>. Учитываются ручные отметки владельца; повторные расчёты одной встречи не увеличивают счётчик. Отмена и повторное открытие записываются отдельно, новый отчёт учитывает изменения.</p>
      <section aria-label="Метрики основных прогнозов"><h3>Метрики · N={{ selected.summary.metrics.n }}</h3>
        <p v-if="!selected.summary.metrics.n">Нет основных прогнозов с проверенным исходом в этой выборке. Метрики не рассчитаны.</p>
        <div class="summary-grid">
          <p><strong>{{ metricLabel(selected.summary.metrics.accuracy,true) }}</strong><span>Accuracy · N={{ selected.summary.metrics.accuracyN }}</span></p>
          <p><strong>{{ metricLabel(selected.summary.metrics.brier) }}</strong><span>Brier · N={{ selected.summary.metrics.n }}</span></p>
          <p><strong>{{ metricLabel(selected.summary.metrics.logLoss) }}</strong><span>Log loss · N={{ selected.summary.metrics.n }}</span></p>
        </div>
        <p>Верных фаворитов: {{ selected.summary.metrics.correct }}. Без фаворита при p=0,5: {{ selected.summary.metrics.ties }}; они исключены только из accuracy.</p>
        <p>При совпавшем составе: N={{ selected.summary.matchedLineupMetrics.n }}, accuracy {{ metricLabel(selected.summary.matchedLineupMetrics.accuracy,true) }} (N={{ selected.summary.matchedLineupMetrics.accuracyN }}), Brier {{ metricLabel(selected.summary.matchedLineupMetrics.brier) }}, log loss {{ metricLabel(selected.summary.matchedLineupMetrics.logLoss) }}.</p>
      </section>
      <details><summary>Таблица калибровки и правила расчёта</summary>
        <p>Вероятности победы A без округления участвуют в метриках. Log loss использует натуральный логарифм и ограничение вероятности 1e-15. Таблица описывает наблюдения и сама по себе не подтверждает качество модели.</p>
        <div class="table-scroll" tabindex="0" role="region" aria-label="Таблица калибровки"><table><thead><tr><th>Вероятность A</th><th>N</th><th>Средняя вероятность</th><th>Частота побед A</th></tr></thead><tbody>
          <tr v-for="bin in selected.summary.metrics.reliability" :key="bin.lower"><td>[{{ metricLabel(bin.lower,true) }}; {{ metricLabel(bin.upper,true) }}{{ bin.upperInclusive?']':')' }}</td><td>{{ bin.n }}</td><td>{{ metricLabel(bin.meanProbability,true) }}</td><td>{{ metricLabel(bin.observedWinRate,true) }}</td></tr>
        </tbody></table></div>
      </details>
      <section aria-label="Попытки прогноза"><h3>Попытки прогноза</h3>
        <p v-if="!selected.rows.length">В этой странице выборки нет попыток.</p>
        <p v-if="selected.rows.length" class="hint">Показаны {{ selected.offset+1 }}–{{ selected.offset+selected.rows.length }} из {{ selected.summary.counts.attempts }}; от новых к ранним.</p>
        <div v-if="selected.rows.length" class="table-scroll" tabindex="0" role="region" aria-label="Таблица попыток"><table class="attempt-table"><thead><tr><th>Сценарий / создание</th><th>Статус</th><th>Вероятность A / фаворит</th><th>Исход / состав</th><th>Причины и данные</th></tr></thead><tbody>
          <tr v-for="row in selected.rows" :key="row.predictionId"><td><RouterLink :to="`/scenarios/${row.scenario.id}`">{{ row.scenario.title }}</RouterLink><small>Редакция {{ row.scenario.revision }} · A #{{ row.scenario.teamAId }} / B #{{ row.scenario.teamBId }}</small><small>{{ dateLabel(row.createdAt) }}</small></td>
            <td>{{ journalStatus[row.status] }}<small v-if="row.primaryPredictionId&&row.status==='superseded'">Основной #{{ row.primaryPredictionId }}</small></td>
            <td>{{ metricLabel(row.probability,true) }}<small v-if="row.calculationStatus==='unavailable'">Расчёт недоступен</small><small>{{ row.favourite?'Фаворит: '+row.favourite:'Фаворит не определён' }}</small><small v-if="row.correct!==null">{{ row.correct?'Фаворит выиграл':'Фаворит проиграл' }}</small></td>
            <td>{{ row.actualWinner?'Победа '+row.actualWinner:'Результат неизвестен' }}<small>Состав: {{ rosterLabel(row.rosterStatus) }}</small><small v-if="row.matchId">Карта #{{ row.matchId }}</small></td>
            <td><p v-for="reason in [...new Set([...row.reasons,...row.attemptReasons])]" :key="reason">{{ journalReason(reason) }}</p><p v-if="row.sourceChangedSinceRefresh" class="warning">Источник изменился после последней отдельной проверки.</p>
              <details><summary>Сведения о прогнозе</summary><p>Версия модели ID: {{ row.modelId??'отсутствует' }}</p><p>Выдан: {{ dateLabel(row.issuedAt) }}. Срез: {{ dateLabel(row.cutoffAt) }}.</p>
                <p>Ожидаемый состав A: {{ row.expectedLineups.teamA.map(id=>'#'+id).join(', ') }}</p><p>Ожидаемый состав B: {{ row.expectedLineups.teamB.map(id=>'#'+id).join(', ') }}</p>
                <p v-if="row.target?.provider==='opendota'">Назначение: OpenDota series #{{ row.target.providerSeriesId }}, карта {{ row.target.mapNumber }}.</p>
                <p v-else-if="row.target?.provider==='pandascore'">Назначение: PandaScore встреча #{{ row.target.providerMatchId }}, карта 1.
                  <RouterLink :to="`/schedule-targets/${row.target.targetRequestId}`">Сохранённый выбор встречи →</RouterLink>
                  <span v-if="row.scheduleResultBinding">Сохранено ручное сопоставление с OpenDota series #{{ row.scheduleResultBinding.providerSeriesId }}, картой #{{ row.scheduleResultBinding.matchId }}.
                    Проверено владельцем {{ dateLabel(row.scheduleResultBinding.reviewedAt) }}. Источник: {{ row.scheduleResultBinding.sourceUrl }}. SHA связи: {{ row.scheduleResultBinding.sha256 }}.</span>
                  <span v-else-if="row.verifiedScheduleBindingKnown">Ранее подтверждена связь встречи со сыгранной картой. Для этого прогноза нужна отдельная проверка результата; отмена не скрывает известную связь.</span>
                  <span v-else>Связь с результатом карты ещё не подтверждена.</span></p>
                <p v-if="row.lifecycle">Отметка владельца: {{ row.lifecycle.event.request.action==='cancelled'?'отмена':'повторное открытие' }}, редакция {{ row.lifecycle.event.revision }}. Записана {{ dateLabel(row.lifecycle.event.recordedAt) }}; дата события: {{ dateLabel(row.lifecycle.event.request.eventAt) }}. Причина: {{ row.lifecycle.event.request.reason }}. Источник: {{ row.lifecycle.event.request.sourceUrl }}. SHA: {{ row.lifecycle.sha256 }}</p>
                <p v-if="row.outcomeSource">Исход: OpenDota receipt #{{ row.outcomeSource.receiptId }}, редакция данных {{ row.outcomeSource.dataRevision }}. Получен {{ dateLabel(row.outcomeSource.fetchedAt) }}, подтверждён {{ dateLabel(row.outcomeSource.verifiedAt) }}. SHA источника: {{ row.outcomeSource.payloadSha256 }}</p>
                <p>ID: {{ row.predictionId }}</p><p>SHA снимка: {{ row.snapshotSha256 }}</p></details></td></tr>
        </tbody></table></div>
        <div class="pagination"><button v-if="offset" @click="offset=Math.max(0,offset-50)">Новые попытки</button><button v-if="selected.hasMore" @click="offset+=50">Ранние попытки</button></div>
      </section>
      <details><summary>Идентификаторы отчёта</summary><p>Запрос: {{ selected.requestId }}</p><p>SHA отчёта: {{ selected.sha256 }}</p><p>SHA исходных данных: {{ selected.inputSha256 }}</p><p>Полный журнал до фильтрации: {{ selected.summary.inventoryCount }} попыток, {{ selected.summary.globalPrimaryMaps }} основных карт.</p></details>
    </article>
  </main>
</template>
<style scoped>
.journal-page{min-width:0;overflow-wrap:anywhere}.filter-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4)}
label,.filter-control{display:grid;gap:var(--space-2)}.panel button{margin:var(--space-2) var(--space-2) 0 0}ul{padding-left:20px}.attempt-table{min-width:1120px;table-layout:fixed}
.attempt-table th:first-child{width:230px}.attempt-table th:nth-child(2){width:180px}.attempt-table th:nth-child(3){width:170px}.attempt-table th:nth-child(4){width:180px}
small{display:block;color:var(--color-muted);margin-top:var(--space-2)}td p{margin:0 0 var(--space-2)}
@media(max-width:600px){.filter-grid{grid-template-columns:1fr}}
</style>
