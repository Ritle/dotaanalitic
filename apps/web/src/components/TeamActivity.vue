<script setup lang="ts">
import {computed,ref} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {ActivityReportSchema,ActivityRecordSchema,ActivityWriteSchema} from '../../../api/src/modules/catalog/team-activity-contract';
import {readCatalog,dateLabel,CatalogRequestError} from '../catalog';
import {ownerAuth} from '../auth';
const props=defineProps<{id:string}>(),cache=useQueryClient();
const key=computed(()=>['team-activity',props.id]),path=computed(()=>`teams/${encodeURIComponent(props.id)}/activity`);
const query=useQuery({queryKey:key,enabled:computed(()=>!!ownerAuth.value),queryFn:({signal})=>readCatalog(path.value,ActivityReportSchema,signal)});
const current=computed(()=>query.data.value?.current),status=ref<'active'|'inactive'|'unknown'>('unknown'),source=ref(''),note=ref(''),checked=ref(''),effective=ref('');
const basis=ref<'source'|'owner'>('owner');
const busy=ref(false),error=ref(''),open=ref(false),revision=ref(0);let pending:{body:string;id:string}|null=null;
const labels={active:'Активна',inactive:'Неактивна',unknown:'Неизвестно'};
const localNow=()=>{const now=new Date();return new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,16);};
function begin(){revision.value=current.value?.revision??0;status.value=current.value?.status??'unknown';basis.value=current.value?.basis??'owner';source.value=current.value?.sourceUrl??'';note.value='';checked.value=localNow();effective.value='';error.value='';pending=null;}
function toggle(event:Event){const value=(event.target as HTMLDetailsElement).open;if(value&&!open.value)begin();open.value=value;}
async function save(){
 if(busy.value)return;const csrf=ownerAuth.value?.csrfToken,requestPath=path.value,requestKey=[...key.value];error.value='';
 let fields;try{fields={expectedRevision:revision.value,status:status.value,basis:basis.value,sourceUrl:basis.value==='source'?source.value.trim()||null:null,note:note.value.trim(),checkedAt:new Date(checked.value).toISOString(),effectiveAt:effective.value?new Date(effective.value).toISOString():null};}catch{error.value='Проверьте даты.';return;}
 const body=JSON.stringify(fields);if(!pending||pending.body!==body)pending={body,id:crypto.randomUUID()};
 const parsed=ActivityWriteSchema.safeParse({...fields,requestId:pending.id});if(!parsed.success){error.value='Укажите источник HTTPS, пояснение и корректные даты.';return;}
 busy.value=true;
 try{await cache.cancelQueries({queryKey:requestKey,exact:true});
  await readCatalog(requestPath,ActivityRecordSchema,new AbortController().signal,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf??''},body:JSON.stringify(parsed.data)});
  if(!csrf||ownerAuth.value?.csrfToken!==csrf)return;
  // Read the current revision even when an idempotent retry returns an older saved record.
  await cache.invalidateQueries({predicate:q=>['team-activity','catalog','catalog-picker'].includes(String(q.queryKey[0]))});
  await query.refetch();open.value=false;pending=null;
 }catch(e){error.value=e instanceof CatalogRequestError&&e.status===400?'Проверьте статус, основание и даты. Дата проверки не может быть в будущем.':e instanceof CatalogRequestError&&e.status===409?'Статус уже изменён. Перечитайте запись и начните новую правку.':e instanceof Error?e.message:'Не удалось сохранить статус.';}finally{busy.value=false;}
}
</script>
<template>
 <section class="activity" aria-label="Активность команды">
  <h3>Активность команды</h3>
  <p v-if="query.isPending.value" role="status">Читаем отметку активности…</p>
  <p v-else-if="query.error.value" role="alert" class="error">{{query.error.value.message}} <button type="button" @click="query.refetch()">Повторить</button></p>
  <template v-else-if="query.data.value">
   <p :class="current?.status==='inactive'?'warning':'hint'"><strong>{{labels[current?.status??'unknown']}}</strong><span v-if="current"> · {{current.basis==='source'?'отметка по источнику':'решение владельца'}}</span></p>
   <p v-if="current?.status==='inactive'">Команда находится в архиве. Её история и сохранённые сценарии доступны; в обычном поиске она скрыта.</p>
   <p v-else-if="!current||current.status==='unknown'" class="hint">Нет подтверждённой отметки об активности. Команда остаётся в обычном списке.</p>
   <template v-if="current">
    <p>{{current.note}}</p><p v-if="current.sourceUrl"><a :href="current.sourceUrl" target="_blank" rel="noopener noreferrer">Источник отметки</a></p>
    <p class="hint">Основание проверено: {{dateLabel(current.checkedAt)}} · Записано: {{dateLabel(current.recordedAt)}}.</p>
    <p class="hint">Дата изменения статуса: {{current.effectiveAt?dateLabel(current.effectiveAt):'не установлена'}}.</p>
   </template>
   <p class="hint">Это отметка для вашего справочника. Давность карт и список игроков автоматически её не меняют. На расчёт Elo отметка не влияет.</p>
   <details :open="open" @toggle="toggle">
    <summary>Изменить статус команды</summary>
    <form @submit.prevent="save">
     <label>Статус <select v-model="status" :disabled="busy"><option value="unknown">Неизвестно</option><option value="active">Активна</option><option value="inactive">Неактивна</option></select></label>
     <label>Основание <select v-model="basis" :disabled="busy"><option value="owner">Моё решение</option><option value="source">Проверенный источник</option></select></label>
     <label v-if="basis==='source'">Ссылка на источник <input v-model="source" type="url" maxlength="2000" placeholder="https://…" required :disabled="busy"></label>
     <label>Пояснение <textarea v-model="note" minlength="3" maxlength="1000" required :disabled="busy" /></label>
     <label>Когда проверено основание <input v-model="checked" type="datetime-local" required :disabled="busy"></label>
     <label>Когда изменился статус, если известно <input v-model="effective" type="datetime-local" :disabled="busy"></label>
     <p class="hint">Даты вводятся в вашем часовом поясе. Ссылка сохраняется для проверки; приложение не загружает её автоматически.</p>
     <p v-if="error" role="alert" class="error">{{error}}</p>
     <button type="submit" :disabled="busy">{{busy?'Сохранение…':'Сохранить статус'}}</button>
     <button type="button" :disabled="busy" @click="async()=>{await query.refetch();begin();}">Перечитать и начать заново</button>
    </form>
   </details>
   <details v-if="query.data.value.history.length"><summary>История отметок</summary>
    <ul><li v-for="entry in query.data.value.history" :key="entry.revision"><strong>{{labels[entry.status]}}</strong> · {{dateLabel(entry.recordedAt)}}<br>{{entry.note}}
     <span v-if="entry.sourceUrl"> · <a :href="entry.sourceUrl" target="_blank" rel="noopener noreferrer">Источник</a></span></li></ul>
    <p v-if="query.data.value.hasMore" class="hint">Показаны последние 20 отметок. Более ранние записи сохранены в базе.</p>
   </details>
  </template>
 </section>
</template>
<style scoped>
.activity{border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-4);margin-block:var(--space-4);overflow-wrap:anywhere}h3{margin-top:0}form{display:grid;gap:12px;margin-top:12px}label{display:grid;gap:4px}input,textarea,select{max-width:100%;box-sizing:border-box;width:100%}textarea{min-height:70px}summary{cursor:pointer}details{margin-block:12px}li{margin-block:10px}button{white-space:normal}
</style>
