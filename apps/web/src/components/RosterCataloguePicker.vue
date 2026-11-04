<script setup lang="ts">
import {ref} from 'vue';
import {RosterCatalogueSearchResultSchema,type RosterCatalogueCandidate} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
const props=defineProps<{matchId:string;kind:'teams'|'players';label:string;initialQuery:string}>();
const model=defineModel<RosterCatalogueCandidate|null>({required:true}),emit=defineEmits<{source:[sha:string]}>();
const query=ref(props.initialQuery),items=ref<RosterCatalogueCandidate[]|null>(null),busy=ref(false),error=ref(''),fetchedAt=ref('');
async function search(){busy.value=true;error.value='';items.value=null;
 try{const r=await readCatalog(`upcoming/${props.matchId}/catalogue/search`,RosterCatalogueSearchResultSchema,new AbortController().signal,{method:'POST',
  headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify({kind:props.kind,query:query.value})});
  emit('source',r.payloadSha256);items.value=r.items;fetchedAt.value=r.fetchedAt;
 }catch(e){error.value=e instanceof Error?e.message:'Не удалось найти запись.';}finally{busy.value=false;}
}
</script>
<template>
 <section class="source-picker" :aria-label="label">
  <label>{{label}}<input v-model="query" type="search" maxlength="200" @keydown.enter.prevent="search" /></label>
  <button type="button" :disabled="busy||!query.trim()" @click="search">{{busy?'Поиск…':'Найти в OpenDota'}}</button>
  <p v-if="model" class="selected">Выбрано: {{model.name}} · ID {{model.id}}</p>
  <p v-if="fetchedAt" class="hint">Каталог OpenDota: {{dateLabel(fetchedAt)}}. До 25 результатов.</p>
  <p v-if="items?.length===0">Совпадений нет. Попробуйте другой ник или числовой ID аккаунта.</p>
  <ul v-if="items?.length"><li v-for="item in items" :key="item.id">
   <button type="button" :aria-pressed="model?.id===item.id" @click="model=item">{{item.name}} · ID {{item.id}}</button>
   <span v-if="kind==='players'" class="hint">Команда в источнике: {{item.teamName??'не указана'}}{{item.teamId?` · ID ${item.teamId}`:''}}</span>
  </li></ul>
  <p v-if="error" class="error" role="alert">{{error}}</p>
 </section>
</template>
<style scoped>
.source-picker{margin-block:var(--space-3);overflow-wrap:anywhere}label{display:block}.source-picker ul{padding-left:var(--space-4)}li{margin-block:var(--space-2)}li button{max-width:100%;white-space:normal}li span{display:block}.selected{font-weight:600}input{min-width:0;max-width:100%}
</style>
