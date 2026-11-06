<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {V1ScheduleTargetPreviewSchema,SchedulePageResponseSchema,scheduleFreshnessReason,SCHEDULE_FRESHNESS_MESSAGES} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
const props=defineProps<{matchId:string;page?:number}>(),emit=defineEmits<{eligible:[value:boolean]}>(),cache=useQueryClient();
const busy=ref(false),error=ref(''),tick=ref(performance.now());
const timer=setInterval(()=>{tick.value=performance.now();},1000);onBeforeUnmount(()=>clearInterval(timer));
let previewReceived=performance.now(),scheduleReceived=performance.now();
const preview=useQuery({queryKey:computed(()=>['schedule-target-preview',props.matchId]),
  queryFn:({signal})=>readCatalog(`upcoming/${props.matchId}/target-preview`,V1ScheduleTargetPreviewSchema,signal)});
const sourcePage=computed(()=>{
  const endpoint=preview.data.value?.observation.endpoint;
  const match=endpoint?.match(/^\/dota2\/matches\/upcoming\?sort=scheduled_at,id&page=([1-9]|[1-4]\d|50)&per_page=20$/);
  return match?Number(match[1]):props.page??1;
});
const scheduleKey=computed(()=>sourcePage.value===1?['upcoming']:['upcoming',sourcePage.value]);
const schedulePath=(page:number,refresh=false)=>`upcoming${refresh?'/refresh':''}${page===1?'':`?page=${page}`}`;
const schedule=useQuery({queryKey:scheduleKey,enabled:computed(()=>!!preview.data.value),
  queryFn:({signal,queryKey})=>readCatalog(schedulePath(Number(queryKey[1]??1)),SchedulePageResponseSchema,signal)});
watch(()=>preview.data.value,()=>{previewReceived=performance.now();tick.value=previewReceived;},{flush:'sync',immediate:true});
watch(()=>schedule.data.value,()=>{scheduleReceived=performance.now();tick.value=scheduleReceived;},{flush:'sync',immediate:true});
const reason=computed(()=>{
  const p=preview.data.value;if(!p)return null;
  const at=new Date(Date.parse(p.checkedAt)+Math.max(0,tick.value-previewReceived)).toISOString().replace('Z','000Z');
  return scheduleFreshnessReason(p.observation.fetchedAt,at);
});
const eligible=computed(()=>!!preview.data.value?.eligible&&!reason.value&&!preview.error.value&&!preview.isFetching.value);
watch(eligible,value=>emit('eligible',value),{immediate:true});
const nextRefresh=computed(()=>{
  const s=schedule.data.value;if(!s)return null;
  const at=Date.parse(s.computedAt)+Math.max(0,tick.value-scheduleReceived);
  const deadline=Math.max(Date.parse(s.expiresAt??'')||0,Date.parse(s.retryAt??'')||0);
  return deadline>at?new Date(deadline).toISOString():null;
});
const blocked=computed(()=>busy.value||!schedule.data.value?.configured||schedule.data.value.refreshing||!!nextRefresh.value);
const sourceMessages:Record<string,string>={not_configured:'Источник расписания не настроен на сервере.',source_unavailable:'Источник временно недоступен. Сохранённые сведения остаются для просмотра.',
  refresh_in_progress:'Обновление уже выполняется. Перечитайте сведения через несколько секунд.',cooldown:'Повторное обновление пока недоступно.'};
const sourceMessage=computed(()=>sourceMessages[schedule.data.value?.reason??'']??'');
async function refresh(){
  if(blocked.value)return;busy.value=true;error.value='';
  try{
    const key=scheduleKey.value;
    const value=await readCatalog(schedulePath(sourcePage.value,true),SchedulePageResponseSchema,new AbortController().signal,{method:'POST',
      headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:'{}'});
    cache.setQueryData(key,value);
    await cache.invalidateQueries({queryKey:['schedule-target-preview',props.matchId]});
  }catch(e){error.value=e instanceof Error?e.message:'Не удалось обновить расписание.';}finally{busy.value=false;}
}
</script>
<template><section aria-label="Свежесть расписания" class="freshness">
  <p v-if="preview.isFetching.value" role="status">Проверка свежести расписания…</p>
  <p v-if="preview.error.value" role="alert" class="error">{{preview.error.value.message}}</p>
  <template v-if="preview.data.value">
    <p>Сведения о встрече получены {{dateLabel(preview.data.value.observation.fetchedAt)}} · страница {{sourcePage}}. Срок актуальности — 5 минут.</p>
    <p v-if="reason" class="warning" role="status">{{SCHEDULE_FRESHNESS_MESSAGES[reason]}}</p>
    <p v-else-if="eligible" role="status">Расписание актуально для нового назначения или прогноза.</p>
    <p v-if="preview.data.value.omittingLaterPages" class="hint">В более новых страницах встречи нет. Они не обновляют срок её сведений; отсутствие не означает отмену.</p>
  </template>
  <p v-if="sourceMessage" role="status">{{sourceMessage}}</p>
  <p v-if="nextRefresh" class="hint">Следующее обновление доступно после {{dateLabel(nextRefresh)}}.</p>
  <p v-if="error" role="alert" class="error">{{error}}</p>
  <button :disabled="blocked" @click="refresh">{{busy?'Обновление расписания…':'Обновить расписание перед прогнозом'}}</button>
</section></template>
<style scoped>.freshness{margin-block:var(--space-4);overflow-wrap:anywhere}button{margin-top:var(--space-2)}</style>
