<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref} from 'vue';
import {V1ScheduledPredictionViewSchema,type ScenarioInput,type UpcomingMatch} from '@dota/contracts';
import {QuickForecastRequestSchema,QuickForecastProgressResponseSchema,type QuickForecastProgress,type QuickForecastRequest,type QuickForecastResponse} from '../../../api/src/modules/upcoming/quick-forecast-contract';
import {requestQuickForecast,QuickForecastFailure} from '../quick-forecast';
import {ownerAuth} from '../auth';
import {readCatalog} from '../catalog';
import ForecastProgress from './ForecastProgress.vue';
import PredictionResult from './PredictionResult.vue';
import SeriesForecastReadiness from './SeriesForecastReadiness.vue';
const props=defineProps<{match:UpcomingMatch;input:ScenarioInput|null;confirmed:boolean;disabled:boolean}>();
const emit=defineEmits<{busy:[value:boolean]}>();
const busy=ref(false),error=ref(''),pending=ref<QuickForecastRequest|null>(null),result=ref<QuickForecastResponse|null>(null);
const restart=ref(false);
const progress=ref<QuickForecastProgress|null>(null),connectionLost=ref(false);
let pollController:AbortController|null=null,pollTimer:ReturnType<typeof setTimeout>|undefined;
function stopProgress(){pollController?.abort();pollController=null;clearTimeout(pollTimer);}
function startProgress(requestId:string){
 stopProgress();progress.value=null;connectionLost.value=false;const active=new AbortController();pollController=active;
 const poll=async()=>{
  try{const value=await readCatalog(`upcoming/${props.match.providerMatchId}/forecast-progress/${requestId}`,QuickForecastProgressResponseSchema,active.signal);
   if(!active.signal.aborted){progress.value=value.progress;connectionLost.value=false;}
  }catch{if(!active.signal.aborted)connectionLost.value=true;}
  if(!active.signal.aborted)pollTimer=setTimeout(()=>void poll(),1000);
 };
 void poll();
}
const controller=new AbortController();onBeforeUnmount(()=>{controller.abort();stopProgress();emit('busy',false);});
const key=computed(()=>`upcoming-forecast:${ownerAuth.value?.owner.id??''}:${props.match.providerMatchId}`);
function store(){try{sessionStorage.setItem(key.value,JSON.stringify({pending:pending.value,result:result.value?{targetId:result.value.targetId,scenarioId:result.value.scenarioId,requestId:result.value.forecast.requestId}:null}));}catch{/* Storage is optional; server UUID idempotency is authoritative. */}}
onMounted(async()=>{
 try{
  const value=JSON.parse(sessionStorage.getItem(key.value)??'null');
  if(value?.pending){const parsed=QuickForecastRequestSchema.safeParse(value.pending);if(parsed.success)pending.value=parsed.data;}
  if(value?.result){const p=value.result;
   const forecast=await readCatalog(`schedule-targets/${encodeURIComponent(p.targetId)}/forecasts/${encodeURIComponent(p.requestId)}`,V1ScheduledPredictionViewSchema,controller.signal);
   if(!controller.signal.aborted)result.value={targetId:p.targetId,scenarioId:forecast.scenario.id,forecast};
  }
 }catch{if(!controller.signal.aborted)error.value='Не удалось открыть прежний результат. Сохранённую попытку можно повторить.';}
});
async function calculate(){
 if(busy.value)return;error.value='';restart.value=false;
 if(!pending.value){
  if(!props.input||!props.confirmed||props.match.opponents.length!==2)return;
  pending.value=QuickForecastRequestSchema.parse({requestId:crypto.randomUUID(),
   providerTeamAId:props.match.opponents[0]!.providerTeamId,providerTeamBId:props.match.opponents[1]!.providerTeamId,
   teamAId:props.input.teamAId,teamBId:props.input.teamBId,lineupA:props.input.lineupA,lineupB:props.input.lineupB});store();
 }
 busy.value=true;emit('busy',true);startProgress(pending.value.requestId);
 try{const response=await requestQuickForecast(props.match.providerMatchId,pending.value,controller.signal);
  if(controller.signal.aborted)return;stopProgress();progress.value={stage:'complete',state:'complete',reused:progress.value?.reused??false,updatedAt:new Date().toISOString()};connectionLost.value=false;result.value=response;pending.value=null;store();
 }catch(e){
  if(controller.signal.aborted)return;
  stopProgress();
  if(e instanceof QuickForecastFailure){if(progress.value)progress.value={...progress.value,state:'failed'};connectionLost.value=false;}else connectionLost.value=true;
  error.value=e instanceof QuickForecastFailure?e.message:'Ответ не получен. Повторите ту же попытку — сохранённый расчёт не продублируется.';
  if(e instanceof QuickForecastFailure){
   if(['TOURNAMENT_REQUIRED','PREPARATION_CHANGED','REQUEST_CONFLICT','LINEUPS_CHANGED','PARTICIPANTS_CHANGED','TEAM_MAPPING_REQUIRED','SCHEDULE_UNAVAILABLE','VALIDATION_ERROR','OWNER_REQUIRED'].includes(e.code))restart.value=true;
  }
 }finally{stopProgress();busy.value=false;emit('busy',false);}
}
function reset(){stopProgress();progress.value=null;connectionLost.value=false;pending.value=null;result.value=null;error.value='';restart.value=false;store();}
</script>
<template><section class="quick-forecast" aria-label="Прогноз выбранной встречи">
 <SeriesForecastReadiness :match="match" />
 <details class="legacy-map" :open="!!result||!!pending"><summary>Отдельный прогноз первой карты</summary>
 <h3>Прогноз первой карты</h3>
 <p class="hint">Прежний режим: вероятность победы только на первой карте. Она не является прогнозом исхода BO3/BO5.</p>
 <p>До драфта, по выбранным пятёркам. Подготовка карты и сохранение результата выполняются автоматически.</p>
 <p class="hint">Подтверждение Tier 1 не требуется. Если уровень события не проверен, точность для этого уровня отдельно не установлена.</p>
 <p v-if="!confirmed&&!pending&&!result" class="hint">Сначала проверьте и подтвердите пятёрки и роли выше.</p>

 <button v-if="!result&&!restart" type="button" :disabled="busy||(!pending&&(disabled||!confirmed||!input))" @click="calculate">{{busy?'Подготавливаем карту и рассчитываем…':pending?'Повторить получение прогноза':'Получить прогноз первой карты'}}</button>
 <ForecastProgress v-if="busy||progress||connectionLost" :progress="progress" :busy="busy" :connection-lost="connectionLost" />
 <p v-if="error" role="alert" class="error">{{error}}</p>
 <button v-if="restart||result" type="button" :disabled="busy" @click="reset">{{result?'Подготовить новый расчёт':'Начать новую попытку после проверки встречи'}}</button>
 <template v-if="result">
  <PredictionResult :result="result.forecast" compact />
  <p>Расчёт сохранён. <RouterLink to="/forecast-journal">Открыть журнал прогнозов →</RouterLink></p>
  <p><RouterLink :to="{path:`/scenarios/${result.scenarioId}/draft`,query:{scheduleTarget:result.targetId}}">Открыть драфт этой карты →</RouterLink></p>
  <details><summary>Сохранённая карта и история расчётов</summary><RouterLink :to="{path:`/schedule-targets/${result.targetId}`,query:{scenario:result.scenarioId,forecast:result.forecast.requestId}}">Открыть подробности →</RouterLink></details>
 </template>
 </details>
</section></template>
<style scoped>
.quick-forecast{margin-block:var(--space-4);padding:var(--space-4);border:1px solid var(--color-border);border-radius:var(--radius-sm);overflow-wrap:anywhere;min-width:0}.quick-forecast button{max-width:100%;white-space:normal}.tournament-setup{margin-block:var(--space-4)}summary{cursor:pointer;min-height:44px}
</style>
