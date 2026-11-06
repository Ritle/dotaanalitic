<script setup lang="ts">
import {computed,ref,useId,watch} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {CatalogListSchema,type CatalogList} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
type Item=CatalogList['items'][number];
const props=defineProps<{kind:'teams'|'players';label:string;modelValue:string;excludedIds?:string[];selectedLabel?:string}>();
const emit=defineEmits<{'update:modelValue':[value:string];selected:[item:Item]}>();
const uid=useId(),query=ref(''),term=ref<string|null>(null),chosen=ref<Item|null>(null);
const results=useQuery({queryKey:computed(()=>['catalog-picker',props.kind,term.value]),enabled:computed(()=>term.value!==null),
  queryFn:({signal})=>readCatalog(`${props.kind}?${new URLSearchParams({query:term.value??'',limit:'10',offset:'0'})}`,CatalogListSchema,signal)});
// Editing already cleared the choice; its ensuing prop update must preserve the new query.
watch(()=>props.modelValue,value=>{if(chosen.value&&chosen.value.id!==value){chosen.value=null;query.value='';term.value=null;}});
function edit(value:string){query.value=value;term.value=null;chosen.value=null;emit('update:modelValue','');}
function search(){const next=query.value.trim();if(!next)return;
  if(term.value===next)void results.refetch();else term.value=next;
}
function pick(item:Item){
  if(props.excludedIds?.includes(item.id))return;
  chosen.value=item;query.value=(item.name||item.id).slice(0,80);term.value=null;emit('selected',item);emit('update:modelValue',item.id);
}
function clear(){edit('');}
</script>
<template>
  <section class="catalog-picker" :aria-label="label">
    <label :for="uid">{{label}}</label>
    <div class="picker-search"><input :id="uid" :value="query" type="search" maxlength="80" autocomplete="off"
      placeholder="Имя или ID в справочнике" @input="edit(($event.target as HTMLInputElement).value)" @keydown.enter.prevent="search" @keydown.esc="term=null" />
      <button type="button" :disabled="!query.trim()||results.isFetching.value" @click="search">Найти</button></div>
    <div v-if="chosen&&chosen.id===modelValue" class="picked" role="status">
      <span>Выбрано: {{chosen.name||'Без имени'}} · ID {{chosen.id}}</span><button type="button" @click="clear">Сбросить</button>
    </div>
    <div v-else-if="modelValue" class="picked" role="status"><span>Выбрано: {{selectedLabel??modelValue}} · ID {{modelValue}}</span><button type="button" @click="clear">Сбросить</button></div>
    <template v-if="term!==null">
      <p v-if="results.isPending.value||results.isFetching.value" role="status">Поиск в локальном справочнике…</p>
      <div v-else-if="results.error.value" role="alert"><p class="error">{{results.error.value.message}}</p><button type="button" @click="results.refetch()">Повторить поиск</button></div>
      <template v-else-if="results.data.value">
        <p v-if="!results.data.value.items.length" class="hint">В локальном справочнике нет подходящей записи. Уточните имя или ID.</p>
        <ul v-else class="picker-results" :aria-label="`Результаты: ${label}`"><li v-for="entry in results.data.value.items" :key="entry.id">
          <button type="button" :disabled="excludedIds?.includes(entry.id)" :aria-label="`Выбрать ${entry.name||'Без имени'} · ID ${entry.id}`" @click="pick(entry)">
            <strong>{{entry.name||'Без имени'}}</strong><span> ID {{entry.id}}{{entry.secondary?' · '+entry.secondary:''}}</span>
            <span v-if="excludedIds?.includes(entry.id)"> · Уже выбрано в составе</span>
          </button>
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
.picked{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;margin-top:8px}.picked span{overflow-wrap:anywhere;min-width:0}
.picked button{flex-shrink:0}.picker-results{list-style:none;padding:0;margin-block:var(--space-2)}.picker-results li{margin-block:4px}
.picker-results button{display:block;width:100%;text-align:left;white-space:normal;overflow-wrap:anywhere;background:var(--color-elevated);color:var(--color-text)}
.picker-results span{font-size:12px}.hint{font-size:12px}
</style>
