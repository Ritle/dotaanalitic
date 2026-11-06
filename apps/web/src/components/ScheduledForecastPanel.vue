<script setup lang="ts">
import {computed,ref,reactive,watch,onBeforeUnmount} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {ScenarioListSchema,ScenarioSnapshotSchema,V1PredictionHistorySchema,V1ScheduledPredictionViewSchema,V1ScheduledPredictionCreateSchema,
  type V1ScheduleTargetSaved,type V1ScheduledPredictionCreate} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {readPrediction,PredictionRequestError} from '../predictions';
import {createScheduledForecast,scheduledScenarioWarning} from '../scheduled-forecasts';
import PredictionResult from './PredictionResult.vue';
import ScheduledResultPanel from './ScheduledResultPanel.vue';
import ScheduleFreshness from './ScheduleFreshness.vue';
const props=defineProps<{target:V1ScheduleTargetSaved}>(),route=useRoute(),router=useRouter(),cache=useQueryClient();
const id=computed(()=>props.target.record.request.requestId),selectedId=computed(()=>typeof route.query.forecast==='string'?route.query.forecast:'');
const scenarioId=ref(typeof route.query.scenario==='string'?route.query.scenario:''),page=ref(0),offset=ref(0),busy=ref(false),error=ref(''),conflict=ref(false),reviewed=ref(false),fresh=ref(false);
const pending=ref<V1ScheduledPredictionCreate|null>(null),scope=reactive({leagueId:'',eventName:'',from:'',until:'',sourceUrl:'',rationale:''});
let controller:AbortController|null=null;
const scenarios=useQuery({queryKey:computed(()=>['scenarios',page.value]),queryFn:({signal})=>readCatalog(`scenarios?offset=${page.value}`,ScenarioListSchema,signal)});
const scenario=useQuery({queryKey:computed(()=>['scenario',scenarioId.value]),enabled:computed(()=>!!scenarioId.value),
  queryFn:({signal})=>readCatalog(`scenarios/${scenarioId.value}`,ScenarioSnapshotSchema,signal)});
const chosen=computed(()=>scenario.data.value?.id===scenarioId.value?scenario.data.value:null);
const warning=computed(()=>chosen.value?scheduledScenarioWarning(props.target,chosen.value):null);
const history=useQuery({queryKey:computed(()=>['scheduled-forecasts',id.value,offset.value]),
  queryFn:({signal})=>readPrediction(`schedule-targets/${id.value}/forecasts?offset=${offset.value}`,V1PredictionHistorySchema,signal)});
const saved=useQuery({queryKey:computed(()=>['scheduled-forecast',id.value,selectedId.value]),enabled:computed(()=>!!selectedId.value&&!busy.value),
  queryFn:({signal})=>readPrediction(`schedule-targets/${id.value}/forecasts/${selectedId.value}`,V1ScheduledPredictionViewSchema,signal)});
const result=computed(()=>saved.data.value?.target.targetRequestId===id.value?saved.data.value:null);
watch(result,r=>{if(r&&pending.value?.requestId===r.requestId){pending.value=null;error.value='';void cache.invalidateQueries({queryKey:['scheduled-forecasts',id.value]});}});
watch(page,()=>{scenarioId.value='';});onBeforeUnmount(()=>controller?.abort());
async function submit(retry=false){
  if(busy.value)return;error.value='';conflict.value=false;
  let body=retry?pending.value:null;
  if(!body){
    if(!chosen.value||warning.value||!fresh.value)return;
    try{body=V1ScheduledPredictionCreateSchema.parse({requestId:crypto.randomUUID(),scenarioId:chosen.value.id,expectedRevision:chosen.value.revision,
      targetSha256:props.target.sha256,targetScope:reviewed.value?{provider:'opendota',leagueId:scope.leagueId,eventName:scope.eventName,
        fromAt:new Date(scope.from+'Z').toISOString(),until:new Date(scope.until+'Z').toISOString(),tier:1,stage:'main_event',sourceUrl:scope.sourceUrl,rationale:scope.rationale}:null});}
    catch{error.value='Заполните проверку турнира: ID лиги OpenDota, название, период UTC, HTTPS-источник и обоснование от 20 символов.';return;}
  }
  const active=new AbortController(),targetId=id.value;controller=active;pending.value=body;busy.value=true;
  try{
    await router.replace({query:{...route.query,forecast:body.requestId,scenario:body.scenarioId}});
    const response=await createScheduledForecast(targetId,body,active.signal);if(active.signal.aborted)return;
    cache.setQueryData(['scheduled-forecast',targetId,response.requestId],response);pending.value=null;offset.value=0;
    await cache.invalidateQueries({queryKey:['scheduled-forecasts',targetId]});
  }catch(e){if(active.signal.aborted)return;error.value=e instanceof Error?e.message:'Не удалось подтвердить сохранение.';conflict.value=e instanceof PredictionRequestError&&e.status===409;}
  finally{if(controller===active)busy.value=false;}
}
async function refresh(){
  if(conflict.value)pending.value=null;conflict.value=false;error.value='';
  await scenarios.refetch();if(scenarioId.value)await scenario.refetch();await history.refetch();if(selectedId.value)await saved.refetch();
}
</script>
<template><section class="panel" aria-label="Прогноз назначенной карты">
  <h2>Прогноз первой карты</h2><p>Выберите сохранённые 5v5. Попытка закрепит эту редакцию назначения и состава.</p>
  <ScheduleFreshness :key="id" :match-id="target.record.request.providerMatchId" @eligible="fresh=$event" />
  <p><RouterLink :to="{path:'/scenarios/new',query:{scheduleTarget:id}}">Подготовить новый сценарий для этой встречи →</RouterLink></p>
  <p v-if="scenarios.isFetching.value" role="status">Загрузка сценариев…</p><p v-if="scenarios.error.value" role="alert" class="error">{{scenarios.error.value.message}}</p>
  <form @submit.prevent="submit()"><fieldset :disabled="busy||!!pending">
    <legend>Состав и турнир</legend><label for="scheduled-scenario">Сохранённый сценарий</label><select id="scheduled-scenario" v-model="scenarioId"><option value="">Выберите сценарий</option>
      <option v-for="s in scenarios.data.value?.items" :key="s.id" :value="s.id">{{s.input.title}} · редакция {{s.revision}}</option></select>
    <p v-if="scenarios.data.value&&!scenarios.data.value.items.length">На этой странице нет сценариев. Подготовьте и сохраните новый.</p>
    <div><button v-if="page" type="button" @click="page-=20">Новые сценарии</button><button v-if="scenarios.data.value?.hasMore" type="button" @click="page+=20">Ранние сценарии</button></div>
    <p v-if="scenario.isFetching.value&&scenarioId" role="status">Загрузка состава…</p><p v-if="scenario.error.value&&scenarioId" role="alert" class="error">{{scenario.error.value.message}}</p>
    <div v-if="chosen"><p>Редакция {{chosen.revision}} · сохранена {{dateLabel(chosen.recordedAt)}}. <RouterLink :to="{path:`/scenarios/${chosen.id}`,query:{scheduleTarget:id}}">Открыть редактор →</RouterLink></p>
      <p>A: {{chosen.input.lineupA.map(p=>'#'+p.playerId).join(', ')}}</p><p>B: {{chosen.input.lineupB.map(p=>'#'+p.playerId).join(', ')}}</p>
      <p v-if="warning" role="alert" class="warning">{{warning}}</p><p v-else>Команды, турнир, время и карта 1 совпадают с назначением.</p></div>
    <label class="check"><input v-model="reviewed" type="checkbox" />Я проверил, что карта относится к основному событию Tier 1</label>
    <div v-if="reviewed" class="scope-grid"><label>ID лиги OpenDota<input v-model="scope.leagueId" inputmode="numeric" required /></label>
      <label>Название события<input v-model="scope.eventName" maxlength="512" required /></label><label>Начало события UTC<input v-model="scope.from" type="datetime-local" required /></label>
      <label>Конец периода события UTC<input v-model="scope.until" type="datetime-local" required /></label><label>Источник проверки · HTTPS<input v-model="scope.sourceUrl" type="url" required /></label>
      <label>Обоснование Tier 1<input v-model="scope.rationale" minlength="20" maxlength="2000" required /></label></div>
    <p>Без проверки турнира или активной модели попытка сохранится с причинами недоступности.</p>
    <button type="submit" :disabled="!fresh||!chosen||!!warning||scenario.isFetching.value">{{busy?'Расчёт и сохранение…':'Рассчитать назначенную карту'}}</button>
  </fieldset></form>
  <p v-if="busy" role="status">Проверяем назначение, модель и профессиональную историю…</p><p v-if="error" role="alert" class="error">{{error}}</p>
  <button v-if="pending&&!conflict&&!busy" @click="submit(true)">Повторить тот же запрос</button><button :disabled="busy" @click="refresh">Обновить состав и историю</button>
  <h3>История этой редакции назначения</h3><p v-if="history.isFetching.value" role="status">Загрузка истории…</p><p v-if="history.error.value" role="alert" class="error">{{history.error.value.message}}</p>
  <p v-if="history.data.value&&!history.data.value.items.length">Сохранённых попыток пока нет.</p>
  <ul><li v-for="r in history.data.value?.items" :key="r.id"><RouterLink :to="{query:{...route.query,forecast:r.requestId}}">{{dateLabel(r.createdAt)}} · редакция состава {{r.scenarioRevision}} · {{r.status==='done'?'вероятность рассчитана':'недоступен'}}</RouterLink></li></ul>
  <button v-if="offset" :disabled="busy" @click="offset-=20">Новые попытки</button><button v-if="history.data.value?.hasMore" :disabled="busy" @click="offset+=20">Ранние попытки</button>
  <p v-if="selectedId&&saved.isFetching.value" role="status">Загрузка сохранённого расчёта…</p><p v-if="selectedId&&saved.error.value&&!busy&&!pending" role="alert" class="error">{{saved.error.value.message}}</p>
  <p v-if="result&&chosen&&result.scenario.id===chosen.id&&result.scenario.revision!==chosen.revision" class="warning">Сохранённый расчёт относится к редакции {{result.scenario.revision}}. Текущая редакция сценария {{chosen.revision}}.</p>
  <PredictionResult v-if="result" :result="result" /><ScheduledResultPanel v-if="result" :key="result.requestId" :forecast="result" /><p><RouterLink to="/forecast-journal">Журнал прогнозов →</RouterLink></p>
</section></template>
<style scoped>
fieldset{min-width:0;border:1px solid var(--color-border);padding:var(--space-4);border-radius:var(--radius-sm)}label{display:grid;gap:var(--space-2);margin-block:var(--space-3)}
.check{display:flex;align-items:center;gap:var(--space-2)}.check input{width:20px;flex-shrink:0}.scope-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4)}
button{margin:var(--space-2) var(--space-2) 0 0}@media(max-width:600px){.scope-grid{grid-template-columns:1fr}.panel{padding:var(--space-4)}}
</style>
