<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import type {ScenarioSnapshot} from '@dota/contracts';
import {DraftCaptureSavedSchema} from '../../../api/src/modules/scenarios/draft-capture-contract';
import {readCatalog,CatalogRequestError,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
import {captureReason} from '../draft-capture';
import DraftNativeBinding from './DraftNativeBinding.vue';
import DraftHistorySummary from './DraftHistorySummary.vue';
import DraftShadowSummary from './DraftShadowSummary.vue';
import {ShadowSummarySchema} from '../../../api/src/modules/scenarios/draft-shadow-contract';

// Parent keys this component by immutable scenario/revision. Editing the form
// never changes the input of an in-flight capture of the saved revision.
const props=defineProps<{scenario:ScenarioSnapshot;targetId:string;requested:boolean;dirty:boolean}>();
const emit=defineEmits<{reload:[]}>();
const cache=useQueryClient(),busy=ref(false),error=ref(''),conflict=ref(false);
const key=['draft-capture',props.scenario.id,props.scenario.revision];
const path=`scenarios/${props.scenario.id}/draft-captures`;
let attempted=false,disposed=false;
const controller=new AbortController();
onBeforeUnmount(()=>{disposed=true;controller.abort();});
async function read(signal:AbortSignal){
  try{return await readCatalog(`${path}/${props.scenario.revision}`,DraftCaptureSavedSchema,signal);}
  catch(e){if(e instanceof CatalogRequestError&&e.status===404)return null;throw e;}
}
const query=useQuery({queryKey:key,queryFn:({signal})=>read(signal),staleTime:q=>q.state.data?Infinity:0,retry:false,refetchOnWindowFocus:false});
const saved=computed(()=>query.data.value);
const rawHistoryCodes=new Set(['DRAFT_CAPTURE_HISTORY_LIMIT','LOCAL_HISTORY_UNAVAILABLE']);
const historyLimitReached=computed(()=>saved.value?.snapshot.reasons.includes('DRAFT_CAPTURE_HISTORY_LIMIT')??false);
const messages=computed(()=>[...new Set(saved.value?.snapshot.reasons.filter(code=>!rawHistoryCodes.has(code)
  &&!(historyLimitReached.value&&code==='PLAYER_PRO_HISTORY_MISSING')).map(captureReason)??[])]);
const rawHistoryMessages=computed(()=>[...new Set(saved.value?.snapshot.reasons.filter(code=>rawHistoryCodes.has(code)).map(captureReason)??[])]);
async function capture(checkExisting=true){
  if(busy.value||props.dirty||disposed)return;
  busy.value=true;error.value='';conflict.value=false;attempted=true;
  const targetId=props.targetId;
  try{
    // Read first: a lost POST response may already have committed a snapshot.
    const existing=checkExisting?await read(controller.signal):null;
    if(disposed)return;
    if(existing)await readCatalog(`${path}/${props.scenario.revision}/shadow-retry`,ShadowSummarySchema,controller.signal,{
      method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:'{}'});
    const result=existing??await readCatalog(path,DraftCaptureSavedSchema,controller.signal,{
      method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},
      body:JSON.stringify({expectedRevision:props.scenario.revision,...(targetId?{scheduleTargetRequestId:targetId}:{})})
    });
    if(!disposed)cache.setQueryData(key,result);
  }catch(e){
    if(!disposed){conflict.value=e instanceof CatalogRequestError&&e.status===409;
      error.value=conflict.value?'Редакция или назначение карты изменились. Загрузите сохранённую редакцию.':
        e instanceof CatalogRequestError&&e.status===403?'Недостаточно прав или устарела сессия. Обновите страницу.':
        'Не удалось сохранить снимок драфта. Сама редакция карты сохранена; повторите запрос.';}
  }finally{if(!disposed)busy.value=false;}
}
watch([()=>props.requested,()=>props.dirty,()=>query.isSuccess.value,()=>query.isFetching.value,()=>query.data.value],()=>{
  if(props.requested&&!props.dirty&&query.isSuccess.value&&!query.isFetching.value&&query.data.value===null&&!attempted)void capture(false);
},{immediate:true});
async function retry(){
  if(props.requested)await capture();else await query.refetch();
}
</script>
<template>
  <section class="draft-capture" aria-label="Снимок драфта" :aria-busy="busy||query.isFetching.value">
    <strong>Снимок драфта · редакция {{scenario.revision}}</strong>
    <p v-if="dirty" class="hint">Есть новые правки. Снимок относится только к сохранённой редакции.</p>
    <p v-if="busy" role="status">Фиксируем игроков, героев и доступную историю…</p>
    <p v-else-if="query.isFetching.value" role="status">Проверяем сохранённый снимок…</p>
    <template v-else-if="saved">
      <p role="status">{{saved.snapshot.status==='captured'?'Снимок драфта сохранён.':'Снимок сохранён с ограничениями.'}}</p>
      <ul v-if="messages.length" class="warning"><li v-for="message in messages" :key="message">{{message}}</li></ul>
      <p v-if="messages.length" class="hint">После исправления данных сохраните новую редакцию карты. Этот снимок останется неизменным.</p>
      <details><summary>Данные снимка</summary>
        <p v-for="message in rawHistoryMessages" :key="message" class="hint">Исходный подробный снимок: {{message}} Отдельная проверка истории показана ниже.</p>
        <p>Записано: {{dateLabel(saved.recordedAt)}}. История до {{dateLabel(saved.snapshot.decisionCutoffAt)}}.</p>
        <p>Аккаунты: {{saved.snapshot.players.filter(p=>p.accountId!==null).length}} / 10.
          <span v-if="!historyLimitReached">Локальных pro-карт: {{saved.snapshot.history.maps.length}}.</span></p>
        <p class="hint">Полнота истории и фактическое начало карты ещё не проверены. Это фиксация данных, не прогноз.</p>
      </details>
      <DraftHistorySummary :key="saved.id" :scenario-id="scenario.id" :revision="scenario.revision" :capture-id="saved.id" />
      <DraftShadowSummary :key="saved.id" :scenario-id="scenario.id" :revision="scenario.revision" :capture-id="saved.id" :dirty="dirty" />
      <DraftNativeBinding :key="saved.id" :scenario-id="scenario.id" :revision="scenario.revision" :capture-id="saved.id" :dirty="dirty" />
    </template>
    <p v-else-if="!error&&!query.error.value" class="hint">При сохранении полного драфта снимок создастся автоматически.</p>
    <template v-if="error||query.error.value">
      <p role="alert" class="error">{{error||'Не удалось прочитать снимок. Повторите запрос.'}}</p>
      <button v-if="conflict" type="button" :disabled="busy" @click="emit('reload')">Загрузить сохранённую редакцию · заменить мои правки</button>
      <button v-else type="button" :disabled="busy||dirty||query.isFetching.value" @click="retry">Повторить запрос снимка</button>
    </template>
  </section>
</template>
<style scoped>
.draft-capture{border-top:1px solid var(--color-border);margin-top:12px;padding-top:12px;font-size:14px;overflow-wrap:anywhere}
.draft-capture ul{padding-left:18px}.draft-capture p{margin-block:8px}.draft-capture summary{cursor:pointer;min-height:44px;display:flex;align-items:center}
</style>
