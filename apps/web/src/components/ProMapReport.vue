<script setup lang="ts">
import {computed,ref} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {ProMapResponseSchema} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
import AnalyticDisplayLabels from './AnalyticDisplayLabels.vue';
import PatchDistribution from './PatchDistribution.vue';
import AnalyticEntityLabel from './AnalyticEntityLabel.vue';
import SampleNote from './SampleNote.vue';
import ContextPicker from './ContextPicker.vue';
import ContextFilterLabel from './ContextFilterLabel.vue';
const props=defineProps<{kind:'teams'|'players';id:string}>();
const from=ref(''),cutoff=ref(''),patch=ref(''),opponent=ref(''),player=ref(''),role=ref(''),side=ref(''),league=ref(''),limit=ref('20');
const applied=ref('limit=20');
function apply(){
  const params=new URLSearchParams({limit:limit.value});
  if(from.value)params.set('fromAt',new Date(from.value+'Z').toISOString());
  if(cutoff.value)params.set('cutoffAt',new Date(cutoff.value+'Z').toISOString());
  for(const [key,value] of [['patchId',patch.value],['opponentId',opponent.value],['playerId',props.kind==='teams'?player.value:''],
    ['rolePos',role.value],['side',side.value],['leagueId',league.value]])if(value?.trim())params.set(key!,value.trim());
  const next=params.toString();if(applied.value===next)void refetch();else applied.value=next;
}
const {data,isPending,isFetching,isError,error,refetch}=useQuery({
  queryKey:computed(()=>['pro-maps',props.kind,props.id,applied.value]),enabled:computed(()=>!!ownerAuth.value),
  queryFn:({signal})=>readCatalog(`${props.kind}/${encodeURIComponent(props.id)}/matches?${applied.value}`,ProMapResponseSchema,signal)
});
const report=computed(()=>data.value && data.value.status!=='unavailable'?data.value:null);
const rate=(n:number|null)=>n===null?'—':new Intl.NumberFormat('ru-RU',{style:'percent',maximumFractionDigits:1}).format(n);
const activeFilters=computed(()=>{
  if(!report.value)return '';
  const f=report.value.filters;
  return `Сторона: ${f.side??'обе'} · Роль: ${f.rolePos??'все'} · Последние ${f.limit} карт`;
});
</script>

<template>
  <section class="panel" aria-labelledby="maps-title">
    <h2 id="maps-title">Профессиональные карты</h2>
    <p class="hint">Описание прошлых завершённых карт по текущей локальной базе. Это наблюдаемый win rate, а не вероятность победы. Данные, загруженные позднее, не считаются заранее известными для модели.</p>
    <form class="map-filters" @submit.prevent="apply">
      <div><label for="maps-from">С даты (UTC)</label><input id="maps-from" v-model="from" type="datetime-local"></div>
      <div><label for="maps-cutoff">До момента (UTC)</label><input id="maps-cutoff" v-model="cutoff" type="datetime-local"></div>
      <ContextPicker v-model="patch" kind="patches" label="Карты: проверенный патч" id-label="ID проверенного патча" />
      <ContextPicker v-model="opponent" kind="teams" label="Карты: соперник" id-label="ID соперника" />
      <ContextPicker v-model="league" kind="leagues" label="Карты: турнир" id-label="ID турнира" />
      <ContextPicker v-if="kind==='teams'" v-model="player" kind="players" label="Карты: игрок для фильтра роли" id-label="ID игрока для фильтра роли" />
      <div><label for="maps-role">Подтверждённая роль</label><select id="maps-role" v-model="role"><option value="">Все роли</option><option v-for="r in 5" :key="r" :value="String(r)">Позиция {{r}}</option></select></div>
      <div><label for="maps-side">Сторона карты</label><select id="maps-side" v-model="side"><option value="">Обе стороны</option><option value="radiant">Radiant</option><option value="dire">Dire</option></select></div>
      <div><label for="maps-limit">Размер выборки</label><select id="maps-limit" v-model="limit"><option v-for="n in [10,20,50,100]" :key="n" :value="String(n)">Последние {{n}}</option></select></div>
      <button type="submit">Применить фильтры</button>
    </form>
    <p v-if="isPending" role="status">Загружаем карты…</p>
    <div v-else-if="isError" role="alert"><p class="error">{{error?.message}}</p><button type="button" @click="refetch()">Повторить выборку</button></div>
    <p v-else-if="data?.status==='unavailable'" role="status" class="warning">{{data.message}}</p>
    <AnalyticDisplayLabels v-else-if="report" :patch-ids="report.patchDistribution.map(p=>p.patchId)" v-slot="{labels:analyticLabels}">
      <p class="hint">Период: {{report.filters.fromAt?dateLabel(report.filters.fromAt):'вся доступная история'}} → {{dateLabel(report.filters.cutoffAt)}} (старт строго раньше, карта завершена).</p>
      <div class="hint">Патч: <ContextFilterLabel kind="patches" :id="report.filters.patchId" /> · Турнир: <ContextFilterLabel kind="leagues" :id="report.filters.leagueId" /> · Соперник: <ContextFilterLabel kind="teams" :id="report.filters.opponentId" /> <template v-if="kind==='teams'"> · Игрок: <ContextFilterLabel kind="players" :id="report.filters.playerId" /></template> · {{activeFilters}}</div>
      <div class="summary-grid" role="group" aria-label="Показатели выборки">
        <p><strong>N = {{report.summary.nRaw}}</strong><span>карт</span></p><p><strong>{{report.summary.wins}} / {{report.summary.losses}}</strong><span>побед / поражений</span></p>
        <p><strong>{{rate(report.summary.winRate)}}</strong><span>наблюдаемый win rate</span></p><p><strong>{{report.summary.meanDurationSeconds===null?'—':(report.summary.meanDurationSeconds/60).toFixed(1)}}</strong><span>средняя длительность, мин.</span></p>
      </div>
      <SampleNote :evidence="report.summary.sampleEvidence" />
      <p v-if="report.status==='insufficient_data'">Нет подходящих завершённых pro-карт. При N = 0 частота побед неизвестна.</p>
      <p class="hint">Источник: нормализованные локальные карты · Обновление данных: {{dateLabel(report.summary.dataUpdatedAt)}} · Расчёт: {{dateLabel(report.computedAt)}} · Политика {{report.policyVersion}}</p>
      <p class="warning">{{kind==='teams'?'История организации не описывает автоматически текущую пятёрку. ':''}}Полный подтверждённый состав: {{report.coverage.completeCanonicalRosters}}/{{report.summary.nRaw}}; проверенный патч: {{report.coverage.knownPatch}}/{{report.summary.nRaw}}; проверенная серия: {{report.coverage.knownSeries}}/{{report.summary.nRaw}}; известный соперник: {{report.coverage.knownOpponent}}/{{report.summary.nRaw}}.</p>
      <p class="hint">Кандидаты окна: {{report.coverage.candidates}}. Исключено: неизвестный pro — {{report.coverage.unknownPro}}, не pro — {{report.coverage.nonPro}}, конфликт — {{report.coverage.conflict}}, незавершённые — {{report.coverage.unfinished}}, выбранный игрок не подтверждён — {{report.coverage.identityUnresolved}}, фильтры — {{report.coverage.filterMismatch}}. До ограничения N: {{report.coverage.eligibleBeforeLimit}}.</p>
      <p class="hint">Карт с неизвестной организацией во всём временном окне базы: {{report.coverage.unattributedOrganizationMapsInWindow}}. Это общий контекст базы, не дополнительные карты выбранной команды. Поздняя загрузка среди выбранных карт: {{report.coverage.lateFetchedMaps}}.</p>
      <div class="hint">Патчи выборки: <PatchDistribution :rows="report.patchDistribution" :labels="analyticLabels" />. Скрытые веса и сглаживание не применяются.</div>
      <div v-if="report.maps.length" class="table-scroll"><table class="pro-map-table"><caption class="sr-only">Выбранные профессиональные карты</caption>
        <thead><tr><th scope="col">Карта / дата UTC</th><th scope="col">Сторона / исход</th><th scope="col">Соперник / турнир</th><th scope="col">Патч / роль</th><th scope="col">Качество</th></tr></thead>
        <tbody><tr v-for="m in report.maps" :key="m.matchId"><td><a :href="`https://www.opendota.com/matches/${m.matchId}`" target="_blank" rel="noopener noreferrer">{{m.matchId}}</a><span class="catalog-id">{{dateLabel(m.startedAt)}}</span></td>
          <td>{{m.side==='radiant'?'Radiant':'Dire'}} · {{m.won?'Победа':'Поражение'}}</td><td>ID {{m.opponentId??'неизвестен'}}<span class="catalog-id">Турнир {{m.leagueId??'неизвестен'}}</span></td>
          <td><AnalyticEntityLabel kind="patches" :id="m.patchId" :labels="analyticLabels" /> / {{m.rolePos??'не подтверждена'}}</td><td>{{m.completeCanonicalRoster?'10 игроков':'неполный состав'}}<span class="catalog-id">Серия: {{m.seriesStatus==='verified'?'проверена':m.seriesStatus==='conflict'?'конфликт':'не подтверждена'}}</span><span class="catalog-id">{{m.source}} · rev {{m.dataRevision}} · {{dateLabel(m.syncedAt)}}</span></td>
        </tr></tbody></table></div>
      <button type="button" :disabled="isFetching" @click="refetch()">{{isFetching?'Обновление…':'Перечитать выборку'}}</button>
    </AnalyticDisplayLabels>
  </section>
</template>
