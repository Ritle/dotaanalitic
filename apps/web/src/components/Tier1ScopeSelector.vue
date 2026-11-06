<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,reactive,ref,watch,watchEffect} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {Tier1ScopeSchema,Tier1ScopeListSchema,Tier1ScopeSavedSchema,Tier1ScopeWriteSchema,tier1ScopeMismatch,
 type Tier1Scope,type Tier1ScopeSaved} from '@dota/contracts';
import {readCatalog,dateLabel,CatalogRequestError} from '../catalog';
import {ownerAuth} from '../auth';
const props=defineProps<{modelValue:Tier1Scope|null;localLeagueId:string|null;scheduledAt:string|null}>();
const emit=defineEmits<{'update:modelValue':[value:Tier1Scope|null];invalid:[value:boolean]}>(),cache=useQueryClient();
const selectId='tier1-scope-'+crypto.randomUUID();
const selection=ref(''),reviewed=ref(false),offset=ref(0),busy=ref(false),error=ref('');
const form=reactive({leagueId:'',eventName:'',from:'',until:'',sourceUrl:'',rationale:''});
let controller:AbortController|null=null;onBeforeUnmount(()=>controller?.abort());
const pending=ref<ReturnType<typeof Tier1ScopeWriteSchema.parse>|null>(null);
const list=useQuery({queryKey:computed(()=>['tier1-scopes',props.localLeagueId,props.scheduledAt,offset.value]),
 queryFn:({signal})=>{
  const q=new URLSearchParams({offset:String(offset.value)});
  if(props.localLeagueId)q.set('localLeagueId',props.localLeagueId);if(props.scheduledAt)q.set('at',props.scheduledAt);
  return readCatalog('tier1-scopes?'+q,Tier1ScopeListSchema,signal);
 },refetchOnWindowFocus:false,refetchOnReconnect:false});
const entry=computed(()=>list.data.value?.items.find(e=>e.record.request.scopeId===selection.value)??null);
const manual=computed(()=>selection.value==='new'||(!selection.value&&reviewed.value));
const input=computed(()=>{
 if(!manual.value)return entry.value?.record.request.scope??null;
 try{return Tier1ScopeSchema.parse({provider:'opendota',leagueId:form.leagueId,eventName:form.eventName,fromAt:new Date(form.from+'Z').toISOString(),
  until:new Date(form.until+'Z').toISOString(),tier:1,stage:'main_event',sourceUrl:form.sourceUrl,rationale:form.rationale});}catch{return null;}
});
const mismatch=computed(()=>input.value&&list.data.value?tier1ScopeMismatch(input.value,list.data.value.context):null);
watchEffect(()=>{emit('invalid',reviewed.value&&!input.value);emit('update:modelValue',reviewed.value?input.value:null);});
watch(selection,()=>{reviewed.value=false;error.value='';});
watch(()=>[props.localLeagueId,props.scheduledAt],()=>{reviewed.value=false;});
watch(()=>entry.value?.record.revision,()=>{reviewed.value=false;});
function copy(){
 const s=entry.value?.record.request.scope;if(!s)return;
 Object.assign(form,{leagueId:s.leagueId,eventName:s.eventName,from:s.fromAt.slice(0,-1),until:s.until.slice(0,-1),sourceUrl:s.sourceUrl,rationale:s.rationale});
 selection.value='new';reviewed.value=false;
}
async function save(hide=false,retry=false){
 if(busy.value)return;error.value='';let request=retry?pending.value:null;
 try{
  if(!request){
   const current=hide?entry.value:null;if(hide&&!current)return;
   if(!hide&&(!reviewed.value||!input.value))throw Error('Подтвердите заполненное событие перед сохранением.');
   request=Tier1ScopeWriteSchema.parse({requestId:crypto.randomUUID(),scopeId:current?.record.request.scopeId??crypto.randomUUID(),
    expectedRevision:current?.record.revision??0,enabled:!hide,scope:current?.record.request.scope??input.value});
  }
 }catch{error.value='Заполните проверку турнира и подтвердите выбор перед сохранением.';return;}
 const active=new AbortController();controller=active;pending.value=request;busy.value=true;
 try{
  const saved:Tier1ScopeSaved=await readCatalog('tier1-scopes',Tier1ScopeSavedSchema,active.signal,{method:'POST',
   headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify(request)});
  if(active.signal.aborted)return;pending.value=null;offset.value=0;await nextTick();
  await cache.invalidateQueries({queryKey:['tier1-scopes']});
  const keepReviewed=reviewed.value&&JSON.stringify(input.value)===JSON.stringify(saved.record.request.scope);
  selection.value=saved.record.request.enabled?saved.record.request.scopeId:'';await nextTick();
  reviewed.value=saved.record.request.enabled&&keepReviewed;
 }catch(e){if(active.signal.aborted)return;
  if(e instanceof CatalogRequestError&&e.status===409){pending.value=null;error.value='Запись изменилась. Перечитайте список перед новым действием.';}
  else error.value='Сохранение не подтверждено. Повторите тот же запрос; запись не продублируется.';
 }finally{if(controller===active)busy.value=false;}
}
</script>
<template><section aria-label="Событие Tier 1" class="tier1">
 <label :for="selectId">Сохранённый турнир Tier 1</label><select :id="selectId" v-model="selection" :disabled="busy||!!pending">
  <option value="">Не выбран</option><option value="new">Ввести новое событие</option>
  <option v-for="item in list.data.value?.items" :key="item.record.request.scopeId" :value="item.record.request.scopeId">
   {{item.record.request.scope.eventName}} · OpenDota #{{item.record.request.scope.leagueId}}
 </option></select>
 <p v-if="list.data.value?.context.providerLeagueId">Лига сценария в OpenDota: #{{list.data.value.context.providerLeagueId}}.</p>
 <p v-if="list.isFetching.value" role="status">Загрузка сохранённых событий…</p>
 <p v-if="list.error.value" role="alert">Не удалось загрузить список событий. Можно ввести событие вручную.</p>
 <div class="actions"><button type="button" :disabled="busy||!!pending" @click="list.refetch()">Перечитать список турниров</button>
  <button v-if="offset" type="button" :disabled="busy||!!pending" @click="offset-=20;selection=''">Предыдущие турниры</button>
  <button v-if="list.data.value?.hasMore" type="button" :disabled="busy||!!pending" @click="offset+=20;selection=''">Другие турниры</button></div>
 <div v-if="entry&&!manual" class="saved">
  <p>{{entry.record.request.scope.eventName}} · основное событие Tier 1 по выбору владельца.</p>
  <p>{{dateLabel(entry.record.request.scope.fromAt)}} — {{dateLabel(entry.record.request.scope.until)}} (конец исключён).</p>
  <p>Источник: {{entry.record.request.scope.sourceUrl}}. {{entry.record.request.scope.rationale}}</p>
  <p>Сохранено {{dateLabel(entry.record.recordedAt)}} · редакция {{entry.record.revision}}.</p>
  <button type="button" :disabled="busy||!!pending" @click="copy">Создать копию для исправления</button>
  <button type="button" :disabled="busy||!!pending" @click="save(true)">Убрать из быстрого выбора</button>
 </div>
 <label class="check"><input v-model="reviewed" type="checkbox" :disabled="busy||!!pending" />Я проверил, что карта относится к основному событию Tier 1</label>
 <fieldset v-if="manual" class="scope-grid" :disabled="busy||!!pending">
  <label>ID лиги OpenDota<input v-model="form.leagueId" inputmode="numeric" required /></label>
  <label>Название события<input v-model="form.eventName" maxlength="512" required /></label>
  <label>Начало события UTC<input v-model="form.from" type="datetime-local" step="0.001" required /></label>
  <label>Конец периода события UTC<input v-model="form.until" type="datetime-local" step="0.001" required /></label>
  <label>Источник проверки · HTTPS<input v-model="form.sourceUrl" type="url" required /></label>
  <label>Обоснование Tier 1<input v-model="form.rationale" minlength="20" maxlength="2000" required /></label>
 </fieldset>
 <p v-if="mismatch" class="warning">{{mismatch}} Проверка расчёта сохранит причину недоступности.</p>
 <p>Событие относится к конкретному ID и периоду. Классификация не переносится автоматически на другие сезоны и квалификации.</p>
 <button v-if="manual" type="button" :disabled="busy||!!pending||!reviewed||!input" @click="save()">Сохранить событие для следующих матчей</button>
 <p v-if="error" role="alert" class="error">{{error}}</p>
 <button v-if="pending&&!busy" type="button" @click="save(false,true)">Повторить сохранение события</button>
</section></template>
<style scoped>
.tier1{min-width:0;overflow-wrap:anywhere}label{display:grid;gap:var(--space-2);margin-block:var(--space-3)}
.check{display:flex;align-items:center;gap:var(--space-2)}.check input{width:20px;flex-shrink:0}
.scope-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);border:0;padding:0;margin:0;min-width:0}select{max-width:100%;min-width:0;width:100%}
button{margin:var(--space-2) var(--space-2) 0 0}.saved{padding:var(--space-3);background:var(--color-elevated);border-radius:var(--radius-sm)}
@media(max-width:600px){.scope-grid{grid-template-columns:1fr}}
</style>
