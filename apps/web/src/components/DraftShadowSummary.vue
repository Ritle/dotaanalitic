<script setup lang="ts">
import {computed,onBeforeUnmount,ref} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {ShadowSummarySchema} from '../../../api/src/modules/scenarios/draft-shadow-contract';
import {readCatalog} from '../catalog';
import {ownerAuth} from '../auth';
import {predictionReason} from '../predictions';
const props=defineProps<{scenarioId:string;revision:number;captureId:string;dirty:boolean}>();
const base=`scenarios/${props.scenarioId}/draft-captures/${props.revision}`,busy=ref(false),error=ref('');
const controller=new AbortController();let disposed=false;
onBeforeUnmount(()=>{disposed=true;controller.abort();});
const query=useQuery({queryKey:['draft-shadow-summary',props.captureId],
  queryFn:({signal})=>readCatalog(`${base}/shadow-summary`,ShadowSummarySchema,signal),staleTime:Infinity,retry:false,refetchOnWindowFocus:false});
const shadowReasons = new Map([
  ['SHADOW_CANDIDATE_UNAVAILABLE', 'При сохранении драфта серверу была недоступна проверенная копия модели H2. Для следующего расчёта восстановите исходный файл модели.'],
  ['PRE_CUTOFF_HISTORY_OBSERVATION_MISSING', 'Для этой редакции не удалось зафиксировать историю игроков до расчётного среза.'],
  ['TEN_VERIFIED_PLAYERS_AND_DISTINCT_HEROES_REQUIRED', 'Для расчёта нужны десять подтверждённых аккаунтов игроков и десять разных героев.'],
  ['SELECTION_IDENTITY_NOT_AS_OBSERVED', 'Привязки аккаунтов в драфте и в сохранённой истории различаются.'],
  ['DRAFT_CAPTURE_HISTORY_LIMIT', 'Объём истории превысил лимит снимка.'],
  ['HISTORY_PROJECTION_UNAVAILABLE', 'Для расчёта недоступна сохранённая история карт.'],
  ['HISTORY_WINDOW_START_TRUNCATED', 'История практики на героях не покрывает все 90 дней до среза.'],
  ['HISTORY_WINDOW_END_TRUNCATED', 'История практики на героях не покрывает все 90 дней до среза.'],
]);
const reasonMessages = computed(() => [...new Set((query.data.value?.reasons ?? []).map(
  code => shadowReasons.get(code) ?? predictionReason(code)
))]);
async function retry(){
  if(busy.value||props.dirty)return;busy.value=true;error.value='';
  try{await readCatalog(`${base}/shadow-retry`,ShadowSummarySchema,controller.signal,{method:'POST',headers:{'content-type':'application/json',
    'x-csrf-token':ownerAuth.value?.csrfToken??''},body:'{}'});if(!disposed)await query.refetch();}
  catch{if(!disposed)error.value='Не удалось завершить сохранение расчёта. Повторите запрос.';}finally{if(!disposed)busy.value=false;}
}
</script>
<template>
  <section aria-label="Исследовательский расчёт драфта" :aria-busy="busy||query.isFetching.value">
    <p v-if="query.isFetching.value||busy" role="status">Проверяем сохранение исследовательского расчёта…</p>
    <template v-else-if="query.data.value">
      <p v-if="query.data.value.status==='computed_shadow_only'" role="status">Исследовательский расчёт сохранён. Модель ещё проходит проверку; вероятность не публикуется.</p>
      <template v-else-if="query.data.value.status==='unavailable'">
        <p role="status">Попытка расчёта сохранена. Исследовательский расчёт недоступен.</p>
        <ul v-if="reasonMessages.length"><li v-for="message in reasonMessages" :key="message">{{message}}</li></ul>
      </template>
      <p v-else role="status">Сохранение исследовательского расчёта ещё не завершено.</p>
      <p v-if="query.data.value.observedCommittedAt" class="hint">
        Запись результата подтверждена
        <time :datetime="query.data.value.observedCommittedAt">{{ query.data.value.observedCommittedAt.replace('T',' ').replace('Z',' UTC') }}</time>.
      </p>
      <p v-if="query.data.value.status==='unavailable'" class="hint">После устранения причины сохраните новую редакцию карты.</p>
      <button v-if="['missing','awaiting_receipt'].includes(query.data.value.status)" type="button" :disabled="busy||dirty" @click="retry">Завершить сохранение расчёта</button>
    </template>
    <template v-if="query.error.value"><p role="alert">Не удалось прочитать состояние расчёта.</p><button type="button" @click="query.refetch()">Повторить чтение состояния</button></template>
    <p v-if="error" role="alert">{{error}}</p>
  </section>
</template>
