<script setup lang="ts">
import {computed,reactive,ref,watch,onBeforeUnmount} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {V1ScheduledLifecycleCreateSchema,V1ScheduledLifecycleHistorySchema,V1ScheduledLifecycleViewSchema} from '@dota/contracts';
import {readPrediction,PredictionRequestError} from '../predictions';
import {postScheduledResult} from '../scheduled-results';
import {dateLabel} from '../catalog';
const props=defineProps<{targetId:string}>(),cache=useQueryClient(),root=computed(()=>`schedule-targets/${props.targetId}/lifecycle`);
const key=computed(()=>['scheduled-lifecycle',props.targetId]);
const before=ref<number|null>(null),busy=ref(false),confirmed=ref(false),error=ref(''),conflict=ref(false);
const form=reactive({sourceUrl:'',reason:'',eventAt:''});
const pending=ref<ReturnType<typeof V1ScheduledLifecycleCreateSchema.parse>|null>(null);let controller:AbortController|null=null;
const head=useQuery({queryKey:computed(()=>[...key.value,'head']),queryFn:({signal})=>readPrediction(root.value,V1ScheduledLifecycleHistorySchema,signal)});
const older=useQuery({queryKey:computed(()=>[...key.value,before.value]),enabled:computed(()=>before.value!==null),
  queryFn:({signal})=>readPrediction(root.value+'?beforeRevision='+before.value,V1ScheduledLifecycleHistorySchema,signal)});
const latest=computed(()=>head.data.value?.items[0]),cancelled=computed(()=>latest.value?.event.request.action==='cancelled');
const page=computed(()=>before.value===null?head.data.value:older.data.value);
watch(form,()=>confirmed.value=false,{deep:true,flush:'sync'});watch(latest,()=>confirmed.value=false);
onBeforeUnmount(()=>controller?.abort());
async function save(retry=false){
  if(busy.value)return;error.value='';conflict.value=false;let body=retry?pending.value:null;
  if(!body)try{body=V1ScheduledLifecycleCreateSchema.parse({...form,eventAt:form.eventAt.trim()||null,requestId:crypto.randomUUID(),
    expectedRevision:latest.value?.event.revision??0,action:cancelled.value?'reopened':'cancelled',confirmedByOwner:confirmed.value});}
  catch{error.value='Укажите ссылку, причину от 10 символов и подтвердите действие. Дата — UTC ISO с миллисекундами или пустое поле.';return;}
  pending.value=body;busy.value=true;const active=new AbortController();controller=active;
  try{await postScheduledResult(root.value,V1ScheduledLifecycleViewSchema,body,active.signal);if(active.signal.aborted)return;
    pending.value=null;before.value=null;confirmed.value=false;await cache.invalidateQueries({queryKey:['scheduled-lifecycle']});
  }catch(e){if(active.signal.aborted)return;error.value=e instanceof Error?e.message:'Не удалось сохранить отметку.';conflict.value=e instanceof PredictionRequestError&&e.status===409;}
  finally{if(controller===active)busy.value=false;}
}
async function reload(){if(conflict.value){pending.value=null;conflict.value=false;}error.value='';await head.refetch();if(before.value!==null)await older.refetch();}
</script>
<template><section class="panel" aria-label="Отмена и открытие встречи"><h2>Состояние встречи</h2>
  <p>Отметка владельца действует для всех сохранённых редакций этой встречи. Перенос даты и отсутствие в частичном расписании не меняют её автоматически.</p>
  <p v-if="head.isFetching.value" role="status">Загрузка истории…</p><p v-if="head.error.value" role="alert" class="error">{{head.error.value.message}}</p>
  <p v-if="head.data.value"><strong>{{cancelled?'Отмечена отмена владельцем':latest?'Повторно открыта владельцем':'Отметок отмены нет'}}</strong></p>
  <p v-if="head.data.value?.verifiedBindingExists" class="warning">Для встречи уже подтверждалась сыгранная карта. Отмена останется в истории и не исключит её из статистики. Повторное открытие не разрешает прогноз после начала игры.</p>
  <p v-else-if="cancelled">Новая вероятность для этой встречи не выдаётся до повторного открытия. Ранее сохранённые прогнозы доступны.</p>
  <form @submit.prevent="save()"><fieldset :disabled="busy||!!pending||head.isFetching.value||!!head.error.value||!head.data.value">
    <legend>{{cancelled?'Повторное открытие':'Отметка отмены'}}</legend>
    <label>Источник отметки<input v-model="form.sourceUrl" type="url" maxlength="2048" required /></label>
    <label>Причина отметки<textarea v-model="form.reason" minlength="10" maxlength="1000" rows="3" required /></label>
    <label>Дата события · UTC, если известна<input v-model="form.eventAt" placeholder="2026-11-03T12:00:00.000Z" /></label>
    <p>Если дата неизвестна, оставьте поле пустым. Время сохранения отметки записывается автоматически; ссылка не проверяется сервисом.</p>
    <label class="check"><input v-model="confirmed" type="checkbox" required />Подтверждаю изменение состояния всей встречи</label>
    <button type="submit">{{cancelled?'Повторно открыть встречу':'Отметить отмену встречи'}}</button>
  </fieldset></form>
  <p v-if="busy" role="status">Сохраняем отметку…</p><p v-if="error" role="alert" class="error">{{error}}</p>
  <button v-if="pending&&!conflict&&!busy" @click="save(true)">Повторить ту же отметку</button>
  <button :disabled="busy" @click="reload">Перечитать состояние встречи</button>
  <div v-if="head.data.value?.items.length"><h3>История отметок</h3><ol>
    <li v-for="s in page?.items" :key="s.sha256"><strong>{{s.event.request.action==='cancelled'?'Отмена':'Повторное открытие'}} · редакция {{s.event.revision}}</strong>
      <p>Записано {{dateLabel(s.event.recordedAt)}}. Дата события: {{dateLabel(s.event.request.eventAt)}}.</p>
      <p>{{s.event.request.reason}} · <a :href="s.event.request.sourceUrl" target="_blank" rel="noopener noreferrer">источник отметки</a></p>
      <details><summary>Идентификаторы отметки</summary><p>Запрос {{s.event.request.requestId}} · SHA {{s.sha256}}</p></details></li>
  </ol><p v-if="before!==null&&older.isFetching.value" role="status">Загрузка ранних отметок…</p><p v-if="before!==null&&older.error.value" role="alert" class="error">{{older.error.value.message}}</p>
    <button v-if="before!==null" @click="before=null">Последние отметки</button><button v-if="page?.nextBeforeRevision" @click="before=page.nextBeforeRevision">Ранние отметки</button></div>
  <p>Чтобы учесть отметку в статистике, создайте новый отчёт в <RouterLink to="/forecast-journal">журнале прогнозов</RouterLink>. Сохранённые отчёты сохраняют прежнее состояние.</p>
</section></template>
<style scoped>
.panel{min-width:0;overflow-wrap:anywhere}fieldset{min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-4)}
label{display:grid;gap:var(--space-2);margin-block:var(--space-3)}.check{display:flex;align-items:center;gap:var(--space-2)}.check input{width:20px;flex-shrink:0}
button{margin:var(--space-2) var(--space-2) 0 0}textarea{width:100%;box-sizing:border-box}@media(max-width:600px){.panel{padding:var(--space-4)}}
</style>
