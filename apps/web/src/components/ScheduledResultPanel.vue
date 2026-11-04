<script setup lang="ts">
import {computed,ref,reactive,watch,onBeforeUnmount} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {V1ScheduledBindingCreateSchema,V1ScheduledBindingViewSchema,V1ScheduledBindingStateSchema,V1ScheduledOutcomeRefreshSchema,V1ScheduledOutcomeViewSchema,V1ScheduledOutcomeHistorySchema,
  type V1ScheduledPredictionView,type V1ScheduledBindingCreate,type V1ScheduledOutcomeRefresh,type V1ScheduledOutcomeView} from '@dota/contracts';
import {readPrediction,PredictionRequestError} from '../predictions';
import {postScheduledResult} from '../scheduled-results';
import {dateLabel} from '../catalog';
import {journalReason,rosterLabel} from '../journal';
const props=defineProps<{forecast:V1ScheduledPredictionView}>(),cache=useQueryClient();
const targetId=computed(()=>props.forecast.target.targetRequestId),forecastId=computed(()=>props.forecast.requestId);
const root=computed(()=>`schedule-targets/${targetId.value}/forecasts/${forecastId.value}`);
const key=computed(()=>['scheduled-result',targetId.value,forecastId.value]);
const busy=ref(false),error=ref(''),conflict=ref(false),confirmed=ref(false),before=ref<number|null>(null),selected=ref<V1ScheduledOutcomeView|null>(null);
const pendingBind=ref<V1ScheduledBindingCreate|null>(null),pendingRefresh=ref<V1ScheduledOutcomeRefresh|null>(null);
const form=reactive({matchId:'',providerSeriesId:'',sourceUrl:'',rationale:''});let controller:AbortController|null=null;
const bindingQuery=useQuery({queryKey:computed(()=>[...key.value,'binding']),queryFn:({signal})=>readPrediction(root.value+'/result-binding',V1ScheduledBindingStateSchema,signal)});
const binding=computed(()=>bindingQuery.data.value?.binding??null);
const head=useQuery({queryKey:computed(()=>[...key.value,'outcomes','head']),queryFn:({signal})=>readPrediction(root.value+'/outcomes',V1ScheduledOutcomeHistorySchema,signal)});
const older=useQuery({queryKey:computed(()=>[...key.value,'outcomes',before.value]),enabled:computed(()=>before.value!==null),
  queryFn:({signal})=>readPrediction(root.value+'/outcomes?beforeRevision='+before.value,V1ScheduledOutcomeHistorySchema,signal)});
const page=computed(()=>before.value===null?head.data.value:older.data.value),display=computed(()=>selected.value??head.data.value?.items[0]??null);
watch(binding,b=>{if(b&&pendingBind.value?.requestId===b.requestId){pendingBind.value=null;error.value='';}});
watch(form,()=>{confirmed.value=false;},{deep:true,flush:'sync'});
onBeforeUnmount(()=>controller?.abort());
async function bind(retry=false){
  if(busy.value)return;error.value='';conflict.value=false;
  let body=retry?pendingBind.value:null;
  if(!body)try{body=V1ScheduledBindingCreateSchema.parse({...form,requestId:crypto.randomUUID(),confirmedByOwner:confirmed.value});}
  catch{error.value='Укажите ID карты и серии OpenDota, HTTPS-источник, объяснение от 20 символов и подтвердите сопоставление.';return;}
  const active=new AbortController();controller=active;busy.value=true;pendingBind.value=body;
  try{const response=await postScheduledResult(root.value+'/result-binding',V1ScheduledBindingViewSchema,body,active.signal);if(active.signal.aborted)return;
    cache.setQueryData([...key.value,'binding'],{binding:response});pendingBind.value=null;
    await cache.invalidateQueries({queryKey:['scheduled-result',targetId.value]});
  }catch(e){if(active.signal.aborted)return;error.value=e instanceof Error?e.message:'Не удалось подтвердить связь.';conflict.value=e instanceof PredictionRequestError&&e.status===409;}
  finally{if(controller===active)busy.value=false;}
}
async function verify(retry=false){
  if(busy.value)return;error.value='';conflict.value=false;
  const body=retry?pendingRefresh.value:V1ScheduledOutcomeRefreshSchema.parse({requestId:crypto.randomUUID(),expectedRevision:head.data.value?.items[0]?.revision??0});
  if(!body)return;const active=new AbortController();controller=active;busy.value=true;pendingRefresh.value=body;
  try{const response=await postScheduledResult(root.value+'/outcomes',V1ScheduledOutcomeViewSchema,body,active.signal);if(active.signal.aborted)return;
    selected.value=response;pendingRefresh.value=null;before.value=null;await cache.invalidateQueries({queryKey:key.value});
  }catch(e){if(active.signal.aborted)return;error.value=e instanceof Error?e.message:'Не удалось проверить исход.';conflict.value=e instanceof PredictionRequestError&&e.status===409;}
  finally{if(controller===active)busy.value=false;}
}
async function reload(){
  if(conflict.value){pendingBind.value=null;pendingRefresh.value=null;conflict.value=false;}error.value='';
  await bindingQuery.refetch();await head.refetch();if(before.value!==null)await older.refetch();
}
</script>
<template><section class="panel" aria-label="Связь с результатом карты">
  <h3>Результат сыгранной карты</h3>
  <p>Сопоставьте встречу PandaScore #{{forecast.target.providerMatchId}} с первой картой OpenDota. Победитель и время начала берутся из проверенных данных.</p>
  <p v-if="bindingQuery.isFetching.value" role="status">Загрузка связи…</p><p v-if="bindingQuery.error.value" role="alert" class="error">{{bindingQuery.error.value.message}}</p>
  <article v-if="binding" aria-label="Сохранённая связь с картой"><p><strong>Карта #{{binding.matchId}} · серия OpenDota #{{binding.providerSeriesId}}</strong></p>
    <p>Ручное сопоставление проверено владельцем {{dateLabel(binding.reviewedAt)}}. Эта связь действует для редакции назначения; каждый прогноз сверяется отдельно.</p>
    <p>Источник: <a :href="binding.sourceUrl" target="_blank" rel="noopener noreferrer">{{binding.sourceUrl}}</a></p><p>{{binding.rationale}}</p>
    <details><summary>Идентификаторы связи</summary><p>Запрос {{binding.requestId}} · SHA {{binding.sha256}}</p><p>Исходный прогноз {{binding.predictionRequestId}}</p></details>
  </article>
  <form v-else @submit.prevent="bind()"><fieldset :disabled="busy||!!pendingBind||bindingQuery.isFetching.value||!!bindingQuery.error.value||forecast.targetScope===null">
    <legend>Ручное сопоставление</legend><label>ID карты OpenDota<input v-model="form.matchId" inputmode="numeric" required /></label>
    <label>ID серии OpenDota<input v-model="form.providerSeriesId" inputmode="numeric" required /></label>
    <label>Источник сопоставления · HTTPS<input v-model="form.sourceUrl" type="url" maxlength="2048" required /></label>
    <label>Объяснение сопоставления<textarea v-model="form.rationale" minlength="20" maxlength="2000" rows="3" required /></label>
    <label class="check"><input v-model="confirmed" type="checkbox" required />Я проверил, что это первая карта именно этой встречи</label>
    <p>Карта должна быть импортирована и проверена в локальной истории. Связь сохраняется неизменяемо; проверьте повторные встречи тех же команд.</p>
    <button type="submit">Сохранить связь с картой</button>
  </fieldset><p v-if="forecast.targetScope===null" class="warning">Эта попытка сохранена без проверки турнира Tier 1. Привязка результата для неё недоступна.</p></form>
  <button v-if="pendingBind&&!conflict&&!busy" @click="bind(true)">Повторить сохранение той же связи</button>
  <p v-if="busy" role="status">Проверяем и сохраняем сведения…</p><p v-if="error" role="alert" class="error">{{error}}</p>
  <button :disabled="busy" @click="reload">Перечитать связь и сверки</button>
  <div v-if="binding"><p>Новая сверка проверяет текущие локальные факты. При неизменных данных сохраняется прежняя редакция.</p>
    <button :disabled="busy||!!pendingRefresh||head.isFetching.value||!!head.error.value" @click="verify()">Проверить и сохранить результат</button>
    <button v-if="pendingRefresh&&!conflict&&!busy" @click="verify(true)">Повторить ту же сверку</button></div>
  <p v-if="head.isFetching.value" role="status">Загрузка сверок…</p><p v-if="head.error.value" role="alert" class="error">{{head.error.value.message}}</p>
  <p v-if="head.data.value&&!head.data.value.items.length">Сохранённых сверок этого прогноза пока нет.</p>
  <article v-if="display" aria-label="Сохранённая сверка результата"><h4>Сверка · редакция {{display.revision}}</h4>
    <p>Проверено {{dateLabel(display.result.checkedAt)}}. {{display.result.status==='linked'?'Исход карты подтверждён.':'Текущие данные не подтверждают связь с исходом.'}}</p>
    <p v-if="display.revision!==(head.data.value?.items[0]?.revision??display.revision)" class="warning">Вы просматриваете архивную редакцию. Последняя сохранённая редакция — {{head.data.value?.items[0]?.revision}}.</p>
    <p v-if="display.result.outcome">Победа команды {{display.result.outcome.teamAWon?'A':'B'}} · фактическое начало {{dateLabel(display.result.outcome.startedAt)}}.</p>
    <p>Совпадение составов: {{rosterLabel(display.result.rosterStatus)}}.</p>
    <p>{{display.result.prospectiveEligible?'Прогноз допущен к статистике до старта.':'Эта сверка не допускает прогноз в статистику до старта.'}}</p>
    <ul><li v-for="reason in display.result.reasons" :key="reason">{{journalReason(reason)}}</li></ul>
    <p v-if="display.result.outcome">Источник OpenDota: receipt #{{display.result.outcome.sourceEvidence.receiptId}}, получен {{dateLabel(display.result.outcome.sourceEvidence.receiptFetchedAt)}}; редакция данных {{display.result.outcome.dataRevision}}.</p>
    <details><summary>Идентификаторы сверки</summary><p>SHA {{display.sha256}} · предыдущая SHA {{display.previousSha256??'отсутствует'}}</p></details>
  </article>
  <div v-if="head.data.value?.items.length"><h4>История сверок</h4><ul><li v-for="r in page?.items" :key="r.sha256"><button @click="selected=r">Сверка {{r.revision}} · {{dateLabel(r.result.checkedAt)}}</button></li></ul>
    <p v-if="before!==null&&older.isFetching.value" role="status">Загрузка ранних сверок…</p><p v-if="before!==null&&older.error.value" role="alert" class="error">{{older.error.value.message}}</p>
    <button v-if="before!==null" @click="before=null">Последние сверки</button><button v-if="page?.nextBeforeRevision" @click="before=page.nextBeforeRevision">Ранние сверки</button></div>
  <p>Исходный прогноз остаётся неизменным. Для обновления статистики создайте новый отчёт в <RouterLink to="/forecast-journal">журнале прогнозов</RouterLink>.</p>
</section></template>
<style scoped>
.panel{min-width:0;overflow-wrap:anywhere}fieldset{min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-4)}
label{display:grid;gap:var(--space-2);margin-block:var(--space-3)}.check{display:flex;align-items:center;gap:var(--space-2)}.check input{width:20px;flex-shrink:0}
button{margin:var(--space-2) var(--space-2) 0 0}textarea{max-width:100%;width:100%;box-sizing:border-box}@media(max-width:600px){.panel{padding:var(--space-4)}}
</style>
