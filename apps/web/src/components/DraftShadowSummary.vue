<script setup lang="ts">
import {onBeforeUnmount,ref} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {ShadowSummarySchema} from '../../../api/src/modules/scenarios/draft-shadow-contract';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
const props=defineProps<{scenarioId:string;revision:number;captureId:string;dirty:boolean}>();
const base=`scenarios/${props.scenarioId}/draft-captures/${props.revision}`,busy=ref(false),error=ref('');
const controller=new AbortController();let disposed=false;
onBeforeUnmount(()=>{disposed=true;controller.abort();});
const query=useQuery({queryKey:['draft-shadow-summary',props.captureId],
  queryFn:({signal})=>readCatalog(`${base}/shadow-summary`,ShadowSummarySchema,signal),staleTime:Infinity,retry:false,refetchOnWindowFocus:false});
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
      <p v-else-if="query.data.value.status==='unavailable'" role="status">Попытка расчёта сохранена. Данных или проверенного кандидата пока недостаточно.</p>
      <p v-else role="status">Сохранение исследовательского расчёта ещё не завершено.</p>
      <p v-if="query.data.value.observedCommittedAt" class="hint">Запись результата подтверждена {{dateLabel(query.data.value.observedCommittedAt)}}.</p>
      <p v-if="query.data.value.status==='unavailable'" class="hint">После обновления данных сохраните новую редакцию карты. Эта попытка останется неизменной.</p>
      <button v-if="['missing','awaiting_receipt'].includes(query.data.value.status)" type="button" :disabled="busy||dirty" @click="retry">Завершить сохранение расчёта</button>
    </template>
    <template v-if="query.error.value"><p role="alert">Не удалось прочитать состояние расчёта.</p><button type="button" @click="query.refetch()">Повторить чтение состояния</button></template>
    <p v-if="error" role="alert">{{error}}</p>
  </section>
</template>
