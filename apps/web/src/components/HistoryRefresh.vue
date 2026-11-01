<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {HistoryRefreshResponseSchema} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
const props=defineProps<{teamId:string}>(),cache=useQueryClient(),busy=ref(false),submitError=ref('');
const key=computed(()=>['history-refresh',props.teamId]),path=computed(()=>`teams/${encodeURIComponent(props.teamId)}/history-refresh`);
const {data,isPending,isError,error,refetch}=useQuery({queryKey:key,enabled:computed(()=>!!ownerAuth.value&&!!props.teamId),
  queryFn:({signal})=>readCatalog(path.value,HistoryRefreshResponseSchema,signal),
  refetchInterval:q=>q.state.data?.run&&['queued','running'].includes(q.state.data.run.status)?3000:
    q.state.data?.retryAt&&q.state.data.retryAt>new Date().toISOString()?10000:false});
const active=computed(()=>!!data.value?.run&&['queued','running'].includes(data.value.run.status));
const blocked=computed(()=>busy.value||!data.value?.available||active.value||!!data.value.retryAt);
const states={queued:'В очереди',running:'Выполняется',completed:'Завершено',partial:'Частично',error:'Ошибка'};
const refreshed=ref('');
watch(()=>data.value?.run,async run=>{
  if(!run||!run.finishedAt||refreshed.value===run.id+run.finishedAt)return;refreshed.value=run.id+run.finishedAt;
  for(const prefix of ['pro-maps','catalog','roster','player-heroes','strength','compare'])await cache.invalidateQueries({queryKey:[prefix]});
});
watch(()=>props.teamId,()=>{submitError.value='';refreshed.value='';});
async function start(){
  if(blocked.value)return;busy.value=true;submitError.value='';const target=props.teamId;
  try{const response=await readCatalog(`teams/${encodeURIComponent(target)}/history-refresh`,HistoryRefreshResponseSchema,new AbortController().signal,
    {method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:'{}'});
    cache.setQueryData(['history-refresh',target],response);
  }catch(e){submitError.value=e instanceof Error?e.message:'Не удалось запустить обновление.';}finally{busy.value=false;}
}
</script>
<template>
  <section class="history-refresh" aria-label="Обновление pro-истории">
    <h3>Обновить pro-историю</h3><p class="hint">OpenDota · до 10 завершённых карт организации. Личная история игрока может быть шире этой выборки.</p>
    <p v-if="isPending" role="status">Проверяем состояние…</p>
    <p v-if="isError" class="error" role="alert">{{error?.message}} <button type="button" @click="refetch()">Проверить снова</button></p>
    <template v-if="data">
      <p role="status">{{data.run?states[data.run.status]:'Готово к запуску'}}. {{data.message}}</p>
      <p v-if="data.run" class="hint">Обработано {{data.run.processed}} из {{data.run.selected??'—'}} · повторных {{data.run.duplicates}} · исключено {{data.run.excluded}} · ошибок источника {{data.run.sourceErrors}} · конфликтов {{data.run.conflicts}}</p>
      <p v-if="data.run?.sourceFetchedAt" class="hint">Источник получен: {{dateLabel(data.run.sourceFetchedAt)}}</p>
      <p v-if="data.run?.finishedAt" class="hint">Завершено: {{dateLabel(data.run.finishedAt)}}</p>
      <p v-if="data.retryAt&&!active" class="hint">Следующее обновление: {{dateLabel(data.retryAt)}}</p>
      <button type="button" :disabled="blocked" @click="start">{{busy?'Отправляем…':active?'Обновление выполняется':'Загрузить последние pro-карты'}}</button>
    </template><p v-if="submitError" class="error" role="alert">{{submitError}}</p>
  </section>
</template>
<style scoped>.history-refresh{margin-block:var(--space-6);padding:var(--space-4);border:1px solid var(--color-border);border-radius:var(--radius-sm)}h3{margin-top:0}</style>
