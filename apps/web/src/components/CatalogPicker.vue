<script setup lang="ts">
import {computed,ref,useId,watch} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {CatalogListSchema,TeamOverviewSchema,PlayerOverviewSchema,type CatalogList,type TeamOverview,type PlayerOverview} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {TeamDirectorySchema} from '../../../api/src/modules/catalog/team-activity-contract';
type Item=CatalogList['items'][number];
const props=defineProps<{kind:'teams'|'players';label:string;modelValue:string;excludedIds?:string[];selectedLabel?:string;compact?:boolean}>();
const emit=defineEmits<{'update:modelValue':[value:string];selected:[item:Item]}>();
const uid=useId(),query=ref(''),term=ref<string|null>(null),chosen=ref<Item|null>(null);
const includeArchived=ref(false);
const editing=ref(false),showSearch=computed(()=>!props.compact||!props.modelValue||editing.value);
const overview=useQuery({queryKey:computed(()=>['catalog','overview',props.kind,props.modelValue]),
  enabled:computed(()=>!!props.modelValue&&!props.selectedLabel?.trim()&&chosen.value?.id!==props.modelValue),
  queryFn:({signal}):Promise<TeamOverview|PlayerOverview>=>props.kind==='teams'?
    readCatalog(`teams/${encodeURIComponent(props.modelValue)}`,TeamOverviewSchema,signal):readCatalog(`players/${encodeURIComponent(props.modelValue)}`,PlayerOverviewSchema,signal)});
const results=useQuery({queryKey:computed(()=>['catalog-picker',props.kind,term.value,includeArchived.value]),enabled:computed(()=>term.value!==null),
  queryFn:({signal})=>props.kind==='teams'?readCatalog(`team-directory?${new URLSearchParams({query:term.value??'',limit:'10',offset:'0',activityView:includeArchived.value?'all':'current'})}`,TeamDirectorySchema,signal):readCatalog(`${props.kind}?${new URLSearchParams({query:term.value??'',limit:'10',offset:'0'})}`,CatalogListSchema,signal)});
const displayName=(value?:string|null)=>value?.trim()||(props.kind==='teams'?'Команда без названия':'Игрок без ника');
const recordPath=(id:string)=>`/${props.kind}/${encodeURIComponent(id)}`;
const picked=computed(()=>chosen.value?.id===props.modelValue?chosen.value:null);
const selectedName=computed(()=>picked.value?displayName(picked.value.name):props.selectedLabel?.trim()||
  (overview.data.value?displayName(overview.data.value.entity.name):overview.isFetching.value?'Загрузка имени…':'Имя недоступно'));
const selectedTag=computed(()=>props.kind==='teams'?(picked.value?.secondary??overview.data.value?.entity.secondary)?.trim():null);
// Editing already cleared the choice; its ensuing prop update must preserve the new query.
watch(()=>props.modelValue,value=>{if(chosen.value&&chosen.value.id!==value){chosen.value=null;query.value='';term.value=null;}});
function edit(value:string){query.value=value;term.value=null;chosen.value=null;emit('update:modelValue','');}
function search(){const next=query.value.trim();if(!next)return;
  if(term.value===next)void results.refetch();else term.value=next;
}
function pick(item:Item){
  if(props.excludedIds?.includes(item.id))return;
  chosen.value=item;query.value=displayName(item.name).slice(0,80);term.value=null;editing.value=false;emit('selected',item);emit('update:modelValue',item.id);
}
function clear(){edit('');}
</script>
<template>
  <section class="catalog-picker" :aria-label="label">
    <label v-if="showSearch" :for="uid">{{label}}</label>
    <div v-if="showSearch" class="picker-search"><input :id="uid" :value="query" type="search" maxlength="80" autocomplete="off"
      :placeholder="kind==='teams'?'Название или тег команды':'Ник игрока'" @input="edit(($event.target as HTMLInputElement).value)" @keydown.enter.prevent="search" @keydown.esc="term=null" />
      <button type="button" :disabled="!query.trim()||results.isFetching.value" @click="search">Найти</button></div>
    <label v-if="kind==='teams'" class="hint"><input v-model="includeArchived" type="checkbox"> Искать также в архиве команд</label>
    <div v-if="modelValue" class="picked" role="status" :data-selected-id="modelValue">
      <span><strong v-if="compact">{{selectedName}}</strong><template v-else>Выбрано: {{selectedName}}</template><span v-if="selectedTag"> · {{selectedTag}}</span></span>
      <button v-if="compact&&!showSearch" type="button" @click="editing=true">Заменить</button><button v-else type="button" @click="clear">Сбросить</button>
    </div>
    <template v-if="modelValue">
      <RouterLink v-if="!compact" :to="recordPath(modelValue)" target="_blank" rel="noopener noreferrer" class="record-link">{{kind==='players'?'Проверить выбранный аккаунт':'Карточка выбранной команды'}}</RouterLink>
      <details class="picker-record"><summary>Данные выбранной записи</summary><p>Внутренний ID: {{modelValue}}</p>
        <RouterLink v-if="compact" :to="recordPath(modelValue)" target="_blank" rel="noopener noreferrer">Проверить выбранный аккаунт</RouterLink>
        <button v-if="overview.error.value&&!selectedLabel?.trim()&&!picked" type="button" @click="overview.refetch()">Повторить чтение имени</button>
      </details>
    </template>
    <template v-if="term!==null">
      <p v-if="results.isPending.value||results.isFetching.value" role="status">Поиск в локальном справочнике…</p>
      <div v-else-if="results.error.value" role="alert"><p class="error">{{results.error.value.message}}</p><button type="button" @click="results.refetch()">Повторить поиск</button></div>
      <template v-else-if="results.data.value">
        <p v-if="!results.data.value.items.length" class="hint">В локальном справочнике нет подходящей записи. Уточните название или ник.</p>
        <ul v-else class="picker-results" :aria-label="`Результаты: ${label}`"><li v-for="entry in results.data.value.items" :key="entry.id">
          <button type="button" :data-catalog-id="entry.id" :disabled="excludedIds?.includes(entry.id)" @click="pick(entry)">
            Выбрать <strong>{{displayName(entry.name)}}</strong><span v-if="kind==='teams'&&entry.secondary"> · Тег: {{entry.secondary}}</span>
            <span v-if="'activityStatus' in entry&&entry.activityStatus==='inactive'"> · Архив</span>
            <span v-if="excludedIds?.includes(entry.id)"> · Уже выбрано в составе</span>
          </button>
          <p v-if="results.data.value.items.filter(p=>p.name.trim().toLowerCase()===entry.name.trim().toLowerCase()).length>1" class="hint">Имя повторяется. Проверьте карточку перед выбором.</p>
          <RouterLink :to="recordPath(entry.id)" target="_blank" rel="noopener noreferrer" class="record-link">{{kind==='players'?'Проверить аккаунт':'Карточка команды'}}</RouterLink>
          <details class="picker-record"><summary>Данные записи</summary><p>Внутренний ID: {{entry.id}}</p></details>
        </li></ul>
        <p v-if="results.data.value.hasMore" class="hint">Показаны первые 10 записей. Уточните запрос.</p>
        <p class="hint">Локальный справочник · {{dateLabel(results.data.value.computedAt)}}. Выберите запись из списка.</p>
      </template>
    </template>
  </section>
</template>
<style scoped>
.catalog-picker{margin-block:var(--space-4);min-width:0}.picker-search{display:flex;gap:var(--space-2);align-items:center}
.picker-search input{flex:1;min-width:0;width:0}.picker-search button{flex-shrink:0}
.picked{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;font-size:13px;margin-top:8px}.picked>span{flex:1 1 160px;overflow-wrap:anywhere;min-width:0}
.picked button{flex-shrink:0}.picker-results{list-style:none;padding:0;margin-block:var(--space-2)}.picker-results li{margin-block:4px}
.picker-results button{display:block;width:100%;text-align:left;white-space:normal;overflow-wrap:anywhere;background:var(--color-elevated);color:var(--color-text)}
.picker-results span{font-size:12px}.hint{font-size:12px}
.record-link{display:inline-block;font-size:13px;margin-top:8px}.picker-record{font-size:13px;margin-block:8px;overflow-wrap:anywhere}.picker-record summary{cursor:pointer}
</style>
