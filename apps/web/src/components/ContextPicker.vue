<script setup lang="ts">
import {computed,ref,useId,watch} from 'vue';
import {useQuery,useQueryClient} from '@tanstack/vue-query';
import {ContextCatalogSchema,type ContextKind} from '../../../api/src/modules/catalog/context-catalog-contract';
import {readCatalog,dateLabel} from '../catalog';
import {contextNameKey,useContextLabel} from '../context-catalog';
const props=defineProps<{kind:ContextKind;label:string;idLabel:string;modelValue:string}>();
const emit=defineEmits<{'update:modelValue':[value:string]}>();
const uid=useId(),cache=useQueryClient(),searchText=ref(''),term=ref<string|null>(null),offset=ref(0),editingId=ref(false);
const {query:selected,name}=useContextLabel(()=>props.kind,()=>editingId.value?'':props.modelValue);
const results=useQuery({queryKey:computed(()=>['context-catalog','search',props.kind,term.value,offset.value]),enabled:computed(()=>term.value!==null),
 staleTime:300000,retry:false,refetchOnWindowFocus:false,
 queryFn:({signal})=>readCatalog(`context-catalog?${new URLSearchParams({kind:props.kind,query:term.value??'',offset:String(offset.value)})}`,ContextCatalogSchema,signal)});
watch(()=>props.modelValue,()=>{searchText.value='';term.value=null;offset.value=0;});
function search(){const next=searchText.value.trim();if(term.value===next&&offset.value===0)void results.refetch();else{offset.value=0;term.value=next;}}
function pick(item:{id:string;name:string}){
 cache.setQueryData(contextNameKey(props.kind,item.id),{kind:props.kind,source:'local_catalogue',readAt:results.data.value!.readAt,items:[item],hasMore:false});
 emit('update:modelValue',item.id);term.value=null;searchText.value='';
}
function clear(){emit('update:modelValue','');term.value=null;searchText.value='';}
</script>
<template>
 <section class="context-picker" :aria-label="label">
  <label :for="uid">{{label}}</label>
  <div class="search"><input :id="uid" v-model="searchText" type="search" maxlength="80" placeholder="Поиск по названию" @keydown.enter.prevent="search" /><button type="button" :disabled="results.isFetching.value" @click="search">Найти</button></div>
  <div role="status" :data-selected-id="modelValue" class="selected"><span>Фильтр: {{modelValue?(editingId?'Редактируется числовой ключ':name):kind==='patches'?'Все патчи':'Все турниры'}}</span><button v-if="modelValue" type="button" @click="clear">Сбросить</button></div>
  <p class="hint">Поиск не меняет фильтр. Выберите запись из локального справочника.</p>
  <p v-if="modelValue&&selected.error.value" class="warning">Не удалось прочитать название. Числовой ключ сохранён.<button type="button" @click="selected.refetch()">Повторить название</button></p>
  <details><summary>Технический ID</summary><label :for="uid+'-id'">{{idLabel}}</label><input :id="uid+'-id'" :value="modelValue" inputmode="numeric" maxlength="19" @focus="editingId=true" @blur="editingId=false" @input="emit('update:modelValue',($event.target as HTMLInputElement).value)" />
   <p class="hint">Локальный ключ, не ID внешнего провайдера. Название не подтверждает релиз патча или участие в турнире.</p>
   <p v-if="selected.data.value" class="hint">Название прочитано: {{dateLabel(selected.data.value.readAt)}}.</p>
  </details>
  <template v-if="term!==null">
   <p v-if="results.isFetching.value" role="status">Поиск названий…</p>
   <div v-else-if="results.error.value" role="alert"><p class="error">{{results.error.value.message}}</p><button type="button" @click="results.refetch()">Повторить поиск</button></div>
   <template v-else-if="results.data.value">
    <p v-if="!results.data.value.items.length" class="hint">Подходящие записи не найдены. Текущий фильтр сохранён.</p>
    <ul><li v-for="item in results.data.value.items" :key="item.id"><button type="button" :data-context-id="item.id" @click="pick(item)">Выбрать {{item.name.trim()||(kind==='patches'?'Патч без названия':'Турнир без названия')}}</button>
     <p v-if="results.data.value.items.filter(i=>i.name===item.name).length>1" class="hint">Название повторяется. Сверьте локальный ID.</p><details><summary>Данные записи</summary><span>Локальный ID: {{item.id}}</span></details>
    </li></ul>
    <div class="pages"><button type="button" :disabled="offset===0" @click="offset-=20">Предыдущие названия</button><button type="button" :disabled="!results.data.value.hasMore" @click="offset+=20">Следующие названия</button></div>
    <p class="hint">Локальный каталог · {{dateLabel(results.data.value.readAt)}}.</p>
   </template>
  </template>
 </section>
</template>
<style scoped>
.context-picker{min-width:0;overflow-wrap:anywhere}.search,.selected,.pages{display:flex;gap:8px;align-items:center}.search input{flex:1;min-width:0;width:0}.selected,.pages{flex-wrap:wrap}.selected{font-size:13px;margin-top:8px}.selected span{flex:1 1 160px}ul{list-style:none;padding:0}li{margin-block:8px}li>button{text-align:left;width:100%;white-space:normal}summary{cursor:pointer;min-height:44px;padding-block:8px}.hint{font-size:12px}.pages button{white-space:normal;max-width:100%}
</style>
