<script setup lang="ts">
import {computed,watch,onBeforeUnmount,ref} from 'vue';
import {useQueryClient} from '@tanstack/vue-query';
import type {CompareRequest} from '@dota/contracts';
import {ComparisonHistoryResponseSchema,type ComparisonHistoryResponse} from '../../../api/src/modules/history/comparison-history-contract';
import {ownerAuth,accountAccess} from '../auth';
import {readCatalog,dateLabel} from '../catalog';
const props=defineProps<{input:CompareRequest;trigger:number}>(),emit=defineEmits<{updated:[]}>();
const cache=useQueryClient();
const statusName:Record<string,string>={queued:'В очереди',running:'Загружается',completed:'Завершено',partial:'Завершено частично',error:'Ошибка'};
const data=ref<ComparisonHistoryResponse|null>(null),busy=ref(false),error=ref('');
let controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined,epoch=0;
const active=computed(()=>data.value?.groups.some(g=>g.state==='queued'||g.state==='running'));
const payload=computed(()=>({lineupA:props.input.lineupA.map(p=>p.playerId),lineupB:props.input.lineupB.map(p=>p.playerId),...(props.input.cutoffAt?{cutoffAt:props.input.cutoffAt}:{})}));
let notified=new Set<string>();
function cancel(){epoch++;controller?.abort();if(timer)clearTimeout(timer);timer=undefined;busy.value=false;}
async function load(start:boolean){
 if(busy.value||!ownerAuth.value)return;
 const generation=epoch,selected=payload.value;controller=new AbortController();busy.value=true;error.value='';
 try{
  const params=new URLSearchParams({lineupA:selected.lineupA.join(','),lineupB:selected.lineupB.join(',')});
  if(selected.cutoffAt)params.set('cutoffAt',selected.cutoffAt);
  const key=['comparison-history',selected],signal=controller.signal;
  const response=start?await readCatalog('players/comparison-history',ComparisonHistoryResponseSchema,signal,{
   method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value.csrfToken},body:JSON.stringify(selected)}):
   await cache.fetchQuery({queryKey:key,staleTime:0,retry:false,queryFn:({signal:querySignal})=>readCatalog('players/comparison-history?'+params,ComparisonHistoryResponseSchema,AbortSignal.any([signal,querySignal]))});
  if(generation!==epoch)return;if(start)cache.setQueryData(key,response);data.value=response;
  let changed=false,finished=false;
  for(const group of response.groups){const run=group.history?.run;if(run?.finishedAt&&!notified.has(run.id+run.finishedAt)){
   notified.add(run.id+run.finishedAt);finished=true;if((run.report?.accepted??0)>0)changed=true;
  }}
  if(changed)emit('updated');
  if(active.value||finished)timer=setTimeout(()=>void load(false),3000);
 }catch(e){if(generation===epoch)error.value=e instanceof Error?e.message:'Подготовка истории временно недоступна.';}
 finally{if(generation===epoch)busy.value=false;}
}
watch(()=>JSON.stringify(payload.value),()=>{cancel();data.value=null;error.value='';notified=new Set();},{flush:'sync'});
watch(()=>props.trigger,()=>{
 cancel();
 // A historical comparison never starts modern source downloads.
 if(props.input.cutoffAt){data.value=null;return;}
 void load(!active.value&&accountAccess.value?.role==='owner');
},{immediate:true,flush:'post'});
onBeforeUnmount(cancel);
</script>
<template>
 <section v-if="!input.cutoffAt" aria-label="Подготовка истории для сравнения" class="history-preparation">
  <p v-if="busy&&!data" role="status">Проверяем локальную pro-историю выбранных игроков…</p>
  <template v-if="data">
   <p class="hint">История OpenDota · проверено {{dateLabel(data.checkedAt)}}. При нехватке данных — до {{data.options.maxMaps}} уникальных карт на пятёрку за {{data.options.windowDays}} дней.</p>
   <div v-for="group in data.groups" :key="group.slot" role="status">
    <p><strong>{{group.slot}}</strong><span v-if="group.history?.run"> · {{statusName[group.history.run.status]}}</span> · {{group.message}}</p>
    <details><summary>Покрытие и параметры {{group.slot}}</summary>
    <p v-if="group.coverage" class="hint">Локальное покрытие игроков (pro-карт, все периоды): {{group.coverage.map(p=>p.nRaw).join(' / ')}}.</p>
    <p v-if="group.history?.run" class="hint">Состояние: {{statusName[group.history.run.status]}} · параметры: {{group.history.options?.windowDays}} дней / {{group.history.options?.maxMaps}} карт<span v-if="group.history.retryAt"> · следующая попытка не раньше {{dateLabel(group.history.retryAt)}}</span>.</p>
    <p v-if="group.history?.run?.report" class="hint">Карт выбрано: {{group.history.run.report.selected}}, принято: {{group.history.run.report.accepted}}, исключено: {{group.history.run.report.excluded}}, ошибок: {{group.history.run.report.failed}}. Выборка ограничена источником.</p>
    </details>
   </div>
   <p class="hint">Выборка ограничена источником. Порог 5 карт на игрока управляет загрузкой; готовность прогноза проверяется отдельно.</p>
  </template>
  <p v-if="error" role="alert" class="warning">{{error}} Имеющееся сравнение сохранено. Повторите сравнение, чтобы проверить загрузку.</p>
 </section>
</template>
<style scoped>.history-preparation{margin-block:var(--space-3);padding:var(--space-3);border:1px solid var(--color-border);border-radius:var(--radius-sm)}p{overflow-wrap:anywhere}</style>
