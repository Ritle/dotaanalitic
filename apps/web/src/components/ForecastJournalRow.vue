<script setup lang="ts">
import {computed,ref} from 'vue';
import {useQueryClient} from '@tanstack/vue-query';
import {useQuery} from '@tanstack/vue-query';
import type {V1JournalView} from '@dota/contracts';
import {V1JournalFeedSchema} from '../../../../packages/contracts/dist/journal/feed.js';
import {JournalResultSchema,type JournalResult} from '../../../api/src/modules/scenarios/journal-result-contract';
import {DisplayLabelsSchema} from '../../../api/src/modules/catalog/display-labels-contract';
import {readCatalog,dateLabel} from '../catalog';
import {readJournal,refreshJournalResult,metricLabel} from '../journal';
import {forecastVerdict} from '../forecast-verdict';
type Row=V1JournalView['rows'][number]|typeof V1JournalFeedSchema._output.items[number];
const props=defineProps<{row:Row;live?:boolean}>();
const ids=computed(()=>({teams:[...new Set([props.row.scenario.teamAId,props.row.scenario.teamBId])].sort(),players:[]}));
const labels=useQuery({queryKey:computed(()=>['catalog-display-labels',ids.value]),staleTime:300000,retry:false,refetchOnWindowFocus:false,
 queryFn:({signal})=>readCatalog('catalog-labels?'+new URLSearchParams({teams:ids.value.teams.join(','),players:''}),DisplayLabelsSchema,signal)});
const needsSource=computed(()=>Boolean(props.live&&props.row.target?.provider==='pandascore'&&['pending_verification','unavailable'].includes(props.row.status)));
const result=useQuery<JournalResult>({queryKey:computed(()=>['forecast-provider-result',props.row.requestId]),enabled:needsSource,staleTime:300000,retry:false,refetchOnWindowFocus:false,
 refetchInterval:query=>query.state.data?.state==='finished'||query.state.data?.state==='cancelled'?false:300000,refetchIntervalInBackground:false,
 queryFn:({signal})=>readJournal('/results/'+props.row.requestId,JournalResultSchema,signal)});
const source=computed(()=>needsSource.value?result.data.value:null);
const queryClient=useQueryClient(),refreshing=ref(false),refreshError=ref('');
async function refreshSource(){
 if(refreshing.value)return;refreshing.value=true;refreshError.value='';
 try{const value=await refreshJournalResult(props.row.requestId,JournalResultSchema,new AbortController().signal);
  queryClient.setQueryData(['forecast-provider-result',props.row.requestId],value);
 }catch(e){refreshError.value=e instanceof Error?e.message:'Не удалось сверить результат.';}finally{refreshing.value=false;}
}
const reasonText=computed(()=>({PARTICIPANTS_CHANGED:'Участники источника отличаются от сохранённых.',FIRST_MAP_AMBIGUOUS:'Номер первой карты неоднозначен.',
 FINISHED_WITHOUT_FIRST_MAP:'Встреча завершена, но сведения о первой карте отсутствуют.',FIRST_MAP_NOT_FINISHED:'Источник ещё не подтвердил завершение первой карты.',
 GAME_IDENTITY_CONFLICT:'Идентификаторы карт не согласованы со встречей.',FORFEIT_OR_CANCELLED:'Отмена или технический исход.',
 FIRST_MAP_WINNER_MISSING:'Победитель первой карты не указан.',GAME_TIME_UNCONFIRMED:'Время первой карты не подтверждено.',
 GAME_COMPLETION_UNCONFIRMED:'Статус завершения карты не подтверждён.',NO_ISSUED_PROBABILITY:'Вероятность не была выдана.',
 NOT_BEFORE_MAP_START:'Расчёт не предшествовал началу карты.',NO_FAVOURITE:'Равные вероятности — фаворит не выбран.',
 PROVIDER_FIRST_MAP_RESULT:'Победитель первой карты получен из PandaScore.',SOURCE_UNAVAILABLE:'Источник временно недоступен.',
 SOURCE_NOT_CONFIGURED:'Подключение PandaScore не настроено.',SOURCE_RESPONSE_INVALID:'Ответ источника не прошёл проверку.'
 } as Record<string,string>)[source.value?.reason??'']??'Результат первой карты пока не подтверждён.');
const name=(side:'A'|'B')=>labels.data.value?.teams.find(t=>t.id===(side==='A'?props.row.scenario.teamAId:props.row.scenario.teamBId))?.name??`Команда ${side}`;
const favourite=computed(()=>props.row.probability===null||props.row.probability===.5?null:props.row.probability>.5?'A':'B');
const winner=computed(()=>source.value?.actualWinner??(['eligible','primary','superseded','excluded'].includes(props.row.status)?props.row.actualWinner:null));
const verdict=computed(()=>{
 const base=forecastVerdict(props.row),s=source.value;
 if(!needsSource.value)return props.live&&base.kind==='pending'?{...base,label:'Результат не проверен'}:base;
 if(props.row.calculationStatus!=='done')return base;
 if(result.isFetching.value&&!s)return {label:'Проверяем источник…',tone:'neutral',detail:'Запросы выполняются по очереди с соблюдением лимита API.'};
 if(!s||s.state==='unavailable')return {label:'Источник недоступен',tone:'warning',detail:'Результат пока не удалось получить. Это не означает, что матч продолжается.'};
 if(s.correct!==null)return {label:s.correct?'Прогноз верен':'Прогноз неверен',tone:s.correct?'success':'danger',detail:'По результату первой карты PandaScore. В строгую статистику OpenDota пока не включён.'};
 if(s.state==='not_started')return {label:'Карта ещё не началась',tone:'neutral',detail:'По последним сведениям PandaScore.'};
 if(s.state==='running')return {label:'Первая карта идёт',tone:'warning',detail:'Победитель пока не объявлен источником.'};
 if(s.state==='cancelled')return {label:'Отмена / технический исход',tone:'neutral',detail:'Не оценивается как сыгранная карта.'};
 if(s.state==='postponed')return {label:'Встреча перенесена',tone:'neutral',detail:'Источник не подтвердил новое начало.'};
 if(s.reason==='NO_FAVOURITE')return {label:'Фаворит не выбран',tone:'neutral',detail:'Вероятности равны; не считается верным или неверным.'};
 if(s.reason==='NOT_BEFORE_MAP_START')return {label:'Расчёт после старта карты',tone:'warning',detail:'Не оценивается как предматчевый прогноз.'};
 return {label:'Нужна проверка результата',tone:'warning',detail:'Не подтверждены участники, номер первой карты, её время или победитель.'};
});
</script>
<template><tr :aria-label="'Прогноз: '+row.scenario.title">
 <td class="date">{{dateLabel(row.createdAt)}}</td>
 <td class="meeting"><RouterLink :to="row.target?.provider==='pandascore'?{path:`/schedule-targets/${row.target.targetRequestId}`,query:{scenario:row.scenario.id,forecast:row.requestId}}:{path:`/scenarios/${row.scenario.id}`,query:{forecast:row.requestId}}">{{row.scenario.title}}</RouterLink><small>{{row.target?.provider==='pandascore'?'Первая карта':'Одна карта'}}</small></td>
 <td><template v-if="favourite"><strong>{{name(favourite)}}</strong><small>{{metricLabel(favourite==='A'?row.probability:1-row.probability!,true)}}</small></template><span v-else>{{row.probability===null?'Не выдан':'Нет фаворита · 50%'}}</span></td>
 <td><strong v-if="winner">{{name(winner)}}</strong><span v-else>Не подтверждён</span><small v-if="source?.actualWinner">PandaScore · карта #{{source.providerGameId}}</small></td>
 <td class="verdict"><strong role="heading" aria-level="3" :class="verdict.tone">{{verdict.label}}</strong><small>{{verdict.detail}}</small><small v-if="source?.sourceFetchedAt">Проверено: {{dateLabel(source.sourceFetchedAt)}}</small>
  <button v-if="needsSource" :disabled="result.isFetching.value||refreshing" @click="refreshSource">{{result.isFetching.value||refreshing?'Проверка…':'Сверить с источником'}}</button>
  <small v-if="refreshError" role="alert">{{refreshError}}</small>
 </td>
 <td class="details"><slot /><details v-if="source"><summary>Источник результата</summary><p>{{reasonText}}</p><p>Источник: <a :href="source.sourceUrl" target="_blank" rel="noopener noreferrer">PandaScore</a></p><p>Начало первой карты: {{source.beganAt?dateLabel(source.beganAt):'неизвестно'}}</p><p>SHA: {{source.sourceSha256}}</p><p>Отдельная сверка источника. Снимок прогноза и сохранённые отчёты не изменяются.</p></details></td>
</tr></template>
<style scoped>
td{vertical-align:top;padding:var(--space-3);border-bottom:1px solid var(--color-border)}small{display:block;color:var(--color-muted);font-size:.8rem;margin-top:var(--space-2)}.date{min-width:130px}.meeting{min-width:170px;max-width:260px}.verdict{min-width:230px;max-width:320px}.details{min-width:130px;max-width:260px;overflow-wrap:anywhere}.success{color:var(--color-success)}.danger{color:var(--color-danger)}.warning{color:var(--color-warning)}summary{cursor:pointer;min-height:32px}button{font-size:.8rem;margin-top:var(--space-2)}
</style>
