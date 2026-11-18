<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref} from 'vue';
import type {ScenarioInput,UpcomingMatch} from '@dota/contracts';
import {LiveEstimateHistorySchema,LiveEstimateRequestSchema,LiveEstimateViewSchema,type LiveEstimateRequest,type LiveEstimateView} from '../../../api/src/modules/live/estimate-contract';
import {QuickForecastFailureSchema} from '../../../api/src/modules/upcoming/quick-forecast-contract';
import {QuickForecastFailure} from '../quick-forecast';
import {ownerAuth,accountAccess,AuthRequestError} from '../auth';
import {queryClient} from '../query-client';
import {readCatalog,dateLabel} from '../catalog';
import {predictionReason,probabilityLabel} from '../predictions';
import ForecastLineups from './ForecastLineups.vue';
const props=defineProps<{match:UpcomingMatch;input:ScenarioInput|null;confirmed:boolean;disabled:boolean}>();
const emit=defineEmits<{busy:[value:boolean]}>();
const busy=ref(false),error=ref(''),acknowledged=ref(false);
const pending=ref<LiveEstimateRequest|null>(null),result=ref<LiveEstimateView|null>(null),history=ref<LiveEstimateView[]>([]),restart=ref(false);
const controller=new AbortController(),key=computed(()=>`live-estimate:${ownerAuth.value?.owner.id}:${props.match.providerMatchId}`);
onBeforeUnmount(()=>{controller.abort();emit('busy',false);});
function store(){try{if(pending.value)sessionStorage.setItem(key.value,JSON.stringify(pending.value));else sessionStorage.removeItem(key.value);}catch{/* Server UUID remains authoritative. */}}
async function loadHistory(){const saved=await readCatalog(`live/${props.match.providerMatchId}/estimates`,LiveEstimateHistorySchema,controller.signal);if(!controller.signal.aborted){history.value=saved.items;result.value??=saved.items[0]??null;}}
onMounted(async()=>{try{const p=LiveEstimateRequestSchema.safeParse(JSON.parse(sessionStorage.getItem(key.value)??'null'));if(p.success)pending.value=p.data;await loadHistory();}catch{if(!controller.signal.aborted)error.value='Не удалось прочитать прежние оценки.';}});
async function calculate(){
 if(busy.value)return;error.value='';restart.value=false;
 if(!pending.value){
  if(!props.input||!props.confirmed||!acknowledged.value||props.match.opponents.length!==2)return;
  pending.value=LiveEstimateRequestSchema.parse({requestId:crypto.randomUUID(),acknowledgedConditional:true,
   providerTeamAId:props.match.opponents[0]!.providerTeamId,providerTeamBId:props.match.opponents[1]!.providerTeamId,
   teamAId:props.input.teamAId,teamBId:props.input.teamBId,lineupA:props.input.lineupA,lineupB:props.input.lineupB});store();
 }
 busy.value=true;emit('busy',true);
 try{
  const response=await fetch(`/api/v1/live/${props.match.providerMatchId}/estimates`,{method:'POST',credentials:'same-origin',signal:controller.signal,
   headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify(pending.value)});
  if(response.status===401){ownerAuth.value=null;accountAccess.value=null;queryClient.clear();throw new AuthRequestError(401,'Войдите снова.');}
  const body=await response.json();if(!response.ok){const parsed=QuickForecastFailureSchema.safeParse(body);throw new QuickForecastFailure(parsed.success?parsed.data.error.code:'HTTP_ERROR',parsed.success?parsed.data.error.message:'Ответ не получен. Повторите ту же попытку.',parsed.success?parsed.data.error.leagueId??null:null);}
  const value=LiveEstimateViewSchema.parse(body);if(controller.signal.aborted)return;
  result.value=value;pending.value=null;store();history.value=[value,...history.value.filter(v=>v.requestId!==value.requestId)].slice(0,20);
 }catch(e){if(controller.signal.aborted)return;error.value=e instanceof Error?e.message:'Не удалось получить оценку.';
  if(e instanceof QuickForecastFailure){if(['TOURNAMENT_REQUIRED','REQUEST_CONFLICT','PARTICIPANTS_CHANGED','VALIDATION_ERROR'].includes(e.code))restart.value=true;}
 }finally{busy.value=false;emit('busy',false);}
}
function reset(){pending.value=null;result.value=null;acknowledged.value=false;error.value='';restart.value=false;store();}
</script>
<template><section class="panel live-estimate" aria-label="Условная оценка по пятёркам">
 <h3>Условная оценка по пятёркам</h3>
 <p>Шансы этих составов на отдельной карте по силе игроков. Счёт серии, пики и ход текущей карты не учитываются. Это не вероятность победы в уже идущей игре.</p>
 <p class="hint">Используется проверенная профессиональная история, доступная на момент расчёта. Оценка сохраняется отдельно от статистики точности прогнозов.</p>
 <p class="hint">Подтверждение Tier 1 не требуется; точность для непроверенного уровня турнира отдельно не установлена.</p>
 <template v-if="!result&&accountAccess?.role==='owner'">
  <p v-if="!confirmed&&!pending" class="hint">Подтвердите пятёрки выше.</p>
  <label class="ack"><input v-model="acknowledged" type="checkbox" :disabled="busy||!!pending" /> Понимаю: это сравнение пятёрок без учёта текущей игры</label>

  <button v-if="!restart" :disabled="busy||(!pending&&(disabled||!input||!confirmed||!acknowledged))" @click="calculate">{{busy?'Рассчитываем силу пятёрок…':pending?'Повторить условную оценку':'Рассчитать условную оценку'}}</button>
 </template>
 <div v-if="busy" role="status"><p>Проверяем составы, модель и профессиональную историю…</p><progress aria-label="Расчёт условной оценки" /></div>
 <p v-if="error" role="alert" class="error">{{error}}</p>
 <article v-if="result" aria-label="Сохранённая условная оценка">
  <p><strong>{{result.status==='done'?'Оценка силы пятёрок':'Оценка недоступна'}}</strong></p>
  <div v-if="result.teamAWinProbability!==null" class="probabilities"><p>Команда A <strong>{{probabilityLabel(result.teamAWinProbability)}}</strong></p><p>Команда B <strong>{{probabilityLabel(1-result.teamAWinProbability)}}</strong></p></div>
  <ul v-if="result.reasons.length"><li v-for="reason in result.reasons" :key="reason">{{predictionReason(reason)}}</li></ul>
  <ForecastLineups :input="result.scenario.input" :samples="result.players" label-prefix="Сохранённые пятёрки" lazy />
  <p v-if="result.coverage">История: N={{result.coverage.nRaw}}, эффективный N={{result.coverage.nEff}}. Наименьшая личная выборка — {{result.coverage.minimumPlayerMaps}} карт; минимум выполнен у {{result.coverage.playersMeetingMinimum}} из 10 игроков.</p>
  <p class="hint">{{result.eventName}} · Player Elo V1 · {{result.modelId??'Активная модель недоступна'}}.</p>
  <p class="hint">История всех pro-уровней: {{dateLabel(result.historyFromAt)}} — {{dateLabel(result.cutoffAt)}}. Полнота удалённой истории неизвестна.</p>
  <p class="hint">Источник встречи: PandaScore, {{dateLabel(result.sourceFetchedAt)}}. Расчёт сохранён: {{dateLabel(result.createdAt)}}.</p>
 </article>
 <button v-if="(result||restart)&&accountAccess?.role==='owner'" :disabled="busy" @click="reset">Подготовить новую условную оценку</button>
 <details v-if="history.length"><summary>Сохранённые оценки этой встречи</summary><ul><li v-for="item in history" :key="item.requestId"><button :disabled="busy" @click="result=item">{{dateLabel(item.createdAt)}} · {{item.status==='done'?'рассчитана':'недоступна'}}</button></li></ul></details>
</section></template>
<style scoped>
.live-estimate{min-width:0;overflow-wrap:anywhere}.ack{display:flex;gap:8px;align-items:center}.ack input{width:18px;height:18px;flex:0 0 auto}.probabilities{display:flex;gap:32px;flex-wrap:wrap}.probabilities strong{display:block;font-size:2rem}progress{width:100%}button{white-space:normal;max-width:100%}
</style>
