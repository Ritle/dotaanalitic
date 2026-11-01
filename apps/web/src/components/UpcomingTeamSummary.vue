<script setup lang="ts">
import {computed} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {TeamOverviewSchema,ProMapResponseSchema} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
import HistoryRefresh from './HistoryRefresh.vue';
import SampleNote from './SampleNote.vue';
const props=defineProps<{teamId:string;sideLabel:'A'|'B'}>();
const enabled=computed(()=>!!ownerAuth.value&&!!props.teamId);
const overview=useQuery({queryKey:computed(()=>['catalog','overview','teams',props.teamId]),enabled,
  queryFn:({signal})=>readCatalog(`teams/${encodeURIComponent(props.teamId)}`,TeamOverviewSchema,signal)});
const history=useQuery({queryKey:computed(()=>['pro-maps','teams',props.teamId,'limit=20']),enabled,
  queryFn:({signal})=>readCatalog(`teams/${encodeURIComponent(props.teamId)}/matches?limit=20`,ProMapResponseSchema,signal)});
const report=computed(()=>history.data.value?.status!=='unavailable'?history.data.value:null);
const dates=computed(()=>report.value?.maps.map(m=>m.startedAt).sort()??[]);
const sources=computed(()=>[...new Set(report.value?.maps.map(m=>m.source)??[])].sort().join(', '));
const hasCoverageGaps=computed(()=>{const r=report.value;return !!r&&(
  [r.coverage.knownPatch,r.coverage.knownSeries,r.coverage.completeCanonicalRosters,r.coverage.knownOpponent].some(n=>n<r.summary.nRaw)||
  r.coverage.conflict>0||r.coverage.unknownPro>0||r.coverage.nonPro>0||r.coverage.lateFetchedMaps>0||r.warnings.includes('SOURCE_FETCH_UNKNOWN'));});
const rate=(value:number|null)=>value===null?'—':new Intl.NumberFormat('ru-RU',{style:'percent',maximumFractionDigits:1}).format(value);
</script>
<template>
  <section class="team-summary" :aria-label="`История организации ${sideLabel}`">
    <h3>{{overview.data.value?.entity.name??`Организация ${sideLabel}`}} · ID {{teamId}}</h3>
    <p class="hint">История прошлых карт организации. Сыгранность выбранной пятёрки оценивается отдельно.</p>
    <p v-if="overview.isPending.value" role="status">Читаем имя организации…</p>
    <p v-if="overview.error.value" class="error" role="alert">{{overview.error.value.message}} <button type="button" @click="overview.refetch()">Повторить обзор</button></p>
    <p v-if="history.isPending.value" role="status">Загружаем сводку карт…</p>
    <p v-if="history.error.value" class="error" role="alert">{{history.error.value.message}} <button type="button" @click="history.refetch()">Повторить сводку</button></p>
    <p v-if="history.data.value?.status==='unavailable'" class="warning">{{history.data.value.message}} Откройте полный отчёт и уточните период.</p>
    <template v-if="report">
      <p class="summary-count"><strong>N = {{report.summary.nRaw}}</strong> · {{report.summary.wins}} побед / {{report.summary.losses}} поражений</p>
      <p>Наблюдаемый win rate: <strong>{{rate(report.summary.winRate)}}</strong></p>
      <p class="hint">Выборка: последние {{report.filters.limit}} завершённых pro-карт в локальной базе · обе стороны · все турниры · все патчи.</p>
      <p v-if="dates.length" class="hint">Карты: {{dateLabel(dates[0]!)}} — {{dateLabel(dates.at(-1)!)}}</p>
      <p v-else>Подходящих завершённых pro-карт нет. Частота побед неизвестна.</p>
      <p v-if="report.summary.nRaw&&report.summary.sampleEvidence.smallSample" class="warning">Малая выборка: {{report.summary.nRaw}} карт.</p>
      <p class="hint">Источник: нормализованные локальные pro-карты{{sources?' · '+sources:''}}.</p>
      <p class="hint">Данные обновлены: {{dateLabel(report.summary.dataUpdatedAt)}} · Срез: {{dateLabel(report.filters.cutoffAt)}}</p>
      <details class="quality-details"><summary :class="{warning:hasCoverageGaps}">Выборка и покрытие{{hasCoverageGaps?' · есть пропуски':''}}</summary>
      <SampleNote :evidence="report.summary.sampleEvidence" />
      <p v-if="report.summary.nRaw" class="hint">Проверенный патч: {{report.coverage.knownPatch}}/{{report.summary.nRaw}} · серия: {{report.coverage.knownSeries}}/{{report.summary.nRaw}} · две полные пятёрки: {{report.coverage.completeCanonicalRosters}}/{{report.summary.nRaw}} · соперник: {{report.coverage.knownOpponent}}/{{report.summary.nRaw}}.</p>
      <ul class="quality-notes">
        <li v-if="report.coverage.knownPatch<report.summary.nRaw">Есть карты без проверенного патча.</li>
        <li v-if="report.coverage.knownSeries<report.summary.nRaw">Связи серий подтверждены не для всех карт.</li>
        <li v-if="report.coverage.completeCanonicalRosters<report.summary.nRaw">Есть карты с неполной идентификацией участников.</li>
        <li v-if="report.coverage.knownOpponent<report.summary.nRaw">Соперник определён не у каждой карты.</li>
        <li v-if="report.coverage.conflict">Карт с конфликтами исключено: {{report.coverage.conflict}}.</li>
        <li v-if="report.coverage.unknownPro||report.coverage.nonPro">Исключено: неизвестный pro-статус {{report.coverage.unknownPro}}, непрофессиональные {{report.coverage.nonPro}}.</li>
        <li v-if="report.coverage.lateFetchedMaps">Есть карты, загруженные после временного среза; показатели ретроспективные.</li>
        <li v-if="report.warnings.includes('SOURCE_FETCH_UNKNOWN')">Для части карт время получения источника неизвестно.</li>
      </ul>
      </details>
    </template>
    <RouterLink :to="`/teams/${teamId}`">Полный отчёт организации {{sideLabel}} →</RouterLink>
    <details class="refresh-details"><summary>Обновить историю организации {{sideLabel}}</summary><HistoryRefresh :team-id="teamId" /></details>
  </section>
</template>
<style scoped>
.team-summary{margin-block:var(--space-4);padding:var(--space-4);border:1px solid var(--color-border);border-radius:var(--radius-sm);overflow-wrap:anywhere}
h3{margin-top:0;font-size:16px}.summary-count{font-size:18px}.quality-notes{padding-left:20px;color:var(--color-warning);font-size:14px}
.quality-notes:empty{display:none}.refresh-details,.quality-details{margin-top:var(--space-4)}summary{cursor:pointer;min-height:44px;padding-block:8px}
</style>
