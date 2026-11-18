<script setup lang="ts">
import {useQuery} from '@tanstack/vue-query';
import {DraftHistorySummarySchema} from '../../../api/src/modules/scenarios/draft-history-summary-contract';
import {readCatalog,dateLabel} from '../catalog';
const props=defineProps<{scenarioId:string;revision:number;captureId:string}>();
const query=useQuery({queryKey:['draft-history-summary',props.captureId],
  queryFn:({signal})=>readCatalog(`scenarios/${props.scenarioId}/draft-captures/${props.revision}/history-summary`,DraftHistorySummarySchema,signal),
  staleTime:Infinity,retry:false,refetchOnWindowFocus:false});
const labels:Record<string,string>={
  DRAFT_CAPTURE_HISTORY_LIMIT:'История превысила допустимый объём. Сохраните новую редакцию после устранения ограничения.',
  TEAM_SIDES_UNKNOWN:'Для части карт неизвестны команды или стороны.',
  LOCAL_PRO_HISTORY_MISSING:'На момент сохранения в локальной истории не было профессиональных карт. Обновите историю команд и сохраните новую редакцию.',
  OUTCOME_SOURCE_UNAVAILABLE:'Для прошлых карт нет доступного подтверждения источника исходов. Обновите историю команд и сохраните новую редакцию.',
  PRE_CUTOFF_HISTORY_OBSERVATION_MISSING:'У этой редакции нет сохранённой проверки истории. Сохраните новую редакцию полного драфта.',
};
const reason=(code:string)=>labels[code]??'Часть прошлых карт не прошла проверку источника или результата.';
</script>
<template>
  <section aria-label="Проверенная история драфта" :aria-busy="query.isFetching.value">
    <strong>Проверенная история</strong>
    <p v-if="query.isFetching.value" role="status">Читаем сохранённую проверку истории…</p>
    <template v-else-if="query.error.value">
      <p role="alert">Не удалось прочитать проверку истории.</p>
      <button type="button" @click="query.refetch()">Повторить чтение истории</button>
    </template>
    <template v-else-if="query.data.value">
      <p v-if="query.data.value.status==='saved'" role="status">Проверка истории сохранена. Проверенных исходов: {{query.data.value.verifiedMaps}} из {{query.data.value.maps}}. Не прошли проверку: {{query.data.value.excludedMaps}}.</p>
      <p v-else role="status">{{query.data.value.status==='missing'?'Проверка истории для этой редакции отсутствует.':'История для этой редакции недоступна.'}}</p>
      <ul v-if="query.data.value.reasons.length" class="warning"><li v-for="text in [...new Set(query.data.value.reasons.map(reason))]" :key="text">{{text}}</li></ul>
      <p v-if="query.data.value.readAt" class="hint">Локальная pro-история на {{dateLabel(query.data.value.readAt)}}. Проверка сохранена {{dateLabel(query.data.value.recordedAt!)}}.</p>
      <p class="hint">Это проверка прошлых исходов. Полнота истории игроков и готовность признаков оцениваются отдельно. Прогноз после драфта пока недоступен: модель ещё не активирована.</p>
    </template>
  </section>
</template>
