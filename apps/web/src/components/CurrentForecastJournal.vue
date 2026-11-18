<script setup lang="ts">
import {computed,ref} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {V1JournalFeedSchema,type V1JournalFeedCursor} from '../../../../packages/contracts/dist/journal/feed.js';
import {readJournal,journalReason} from '../journal';
import {dateLabel} from '../catalog';
import ForecastJournalRow from './ForecastJournalRow.vue';
import ForecastLineups from './ForecastLineups.vue';
const pages=ref<(V1JournalFeedCursor|null)[]>([null]),cursor=computed(()=>pages.value.at(-1)??null);
const feed=useQuery({queryKey:computed(()=>['forecast-journal-current',cursor.value]),staleTime:0,refetchOnMount:'always',
  refetchInterval:30000,refetchIntervalInBackground:false,
  queryFn:({signal})=>readJournal('/current'+(cursor.value?'?'+new URLSearchParams(cursor.value).toString():''),V1JournalFeedSchema,signal)});
async function refresh(){if(pages.value.length>1)pages.value=[null];else await feed.refetch();}
</script>
<template><section class="panel" aria-label="Текущие прогнозы">
 <h2>Все сохранённые расчёты</h2>
 <p>Прогноз появляется здесь сразу после расчёта вероятности. Создавать отчёт не нужно.</p>
 <p class="hint">Результаты завершённых карт сохраняются и открываются без повторной загрузки. Незавершённые встречи проверяются не чаще раза в 5 минут. «Сверить с источником» обновляет результат вручную. Здесь показаны прежние прогнозы первой карты.</p>
 <button :disabled="feed.isFetching.value" @click="refresh">Обновить прогнозы</button>
 <p v-if="feed.isFetching.value" role="status">Обновляем список…</p>
 <p v-if="feed.error.value" role="alert">{{feed.error.value.message}}</p>
 <p v-if="feed.data.value" class="hint">Обновлено: {{dateLabel(feed.data.value.readAt)}}</p>
 <p v-if="feed.data.value&&!feed.data.value.items.length">Расчётов пока нет. Получите прогноз на странице предстоящего матча.</p>
 <div class="table-scroll" role="region" aria-label="Таблица текущих прогнозов" tabindex="0"><table>
  <thead><tr><th scope="col">Рассчитано</th><th scope="col">Встреча</th><th scope="col">Прогноз</th><th scope="col">Победитель карты</th><th scope="col">Итог проверки</th><th scope="col">Подробности</th></tr></thead><tbody>
  <ForecastJournalRow v-for="row in feed.data.value?.items" :key="row.predictionId" :row="row" live>
   <details><summary>Составы и сведения о расчёте</summary>
    <ForecastLineups lazy label-prefix="Ожидаемый состав" :input="{teamAId:row.scenario.teamAId,teamBId:row.scenario.teamBId,lineupA:row.expectedLineups.teamA.map(playerId=>({playerId})),lineupB:row.expectedLineups.teamB.map(playerId=>({playerId}))}" />
    <p v-for="reason in row.reasons" :key="reason">{{journalReason(reason)}}</p><p>ID расчёта: {{row.predictionId}}</p>
   </details>
  </ForecastJournalRow>
 </tbody></table></div>
 <div class="pagination"><button v-if="pages.length>1" @click="pages=pages.slice(0,-1)">Новые расчёты</button><button v-if="feed.data.value?.nextCursor" @click="pages=[...pages,feed.data.value.nextCursor]">Ранние расчёты</button></div>
</section></template>
<style scoped>
.table-scroll{max-width:100%;overflow:auto}table{width:100%;min-width:1080px}th{text-align:left;padding:var(--space-3)}summary{cursor:pointer;min-height:32px}
</style>
