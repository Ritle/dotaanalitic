<script setup lang="ts">
import {computed} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import type {UpcomingMatch} from '@dota/contracts';
import {SeriesForecastReadinessSchema} from '../../../../packages/contracts/dist/series/forecast.js';
import {readCatalog,dateLabel} from '../catalog';
const props=defineProps<{match:UpcomingMatch}>();
const readiness=useQuery({queryKey:computed(()=>['series-forecast-readiness',props.match.providerMatchId]),retry:false,staleTime:60000,
 queryFn:({signal})=>readCatalog(`upcoming/${props.match.providerMatchId}/series-forecast/readiness`,SeriesForecastReadinessSchema,signal)});
const format=computed(()=>readiness.data.value?.bestOf??props.match.seriesBestOf);
const reason=(code:string)=>({SERIES_MODEL_NOT_VALIDATED:'Модель победителя встречи ещё не прошла проверку на целых сериях. Вероятность пока недоступна.',
 SERIES_FORMAT_UNKNOWN:'Формат встречи пока неизвестен.',SERIES_FORMAT_UNSUPPORTED:'Этот формат пока не поддерживается. Для BO2 нужно отдельно учитывать ничью.',
 SERIES_SCHEDULE_UNAVAILABLE:'Обновите расписание: сведения о встрече ещё не сохранены.',SCHEDULE_SOURCE_STALE:'Расписание устарело. Обновите список встреч.',
 SCHEDULE_NOT_UPCOMING:'Встреча уже не находится в предстоящих.',SCHEDULE_START_UNKNOWN:'Время начала встречи неизвестно.',
 SCHEDULE_ALREADY_STARTED:'Встреча уже началась. Новый предматчевый прогноз недоступен.',SCHEDULE_OPPONENTS_INCOMPLETE:'В расписании ещё не определены две команды.'
 } as Record<string,string>)[code]??'Для прогноза требуется проверить сведения о встрече.';
</script>
<template><section aria-label="Прогноз всей встречи">
 <h3>Победитель встречи{{format?` · BO${format}`:''}}</h3>
 <p>По пятёркам, до начала встречи. Результат относится ко всей серии. Драфт анализируется отдельно для каждой карты.</p>
 <p v-if="readiness.isPending.value" role="status">Проверяем готовность прогноза…</p>
 <p v-if="readiness.error.value" role="alert">Не удалось проверить готовность прогноза встречи. <button @click="readiness.refetch()">Повторить проверку</button></p>
 <template v-if="readiness.data.value"><p v-for="code in readiness.data.value.reasons" :key="code" class="hint">{{reason(code)}}</p>
  <small v-if="readiness.data.value.sourceFetchedAt">Расписание получено: {{dateLabel(readiness.data.value.sourceFetchedAt)}}</small>
 </template>
</section></template>
