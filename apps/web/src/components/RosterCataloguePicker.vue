<script setup lang="ts">
import {ref,computed} from 'vue';
import {RosterCatalogueSearchResultSchema,type RosterCatalogueCandidate} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
import {preferredHistoryCandidate} from '../roster-preparation';
const props=defineProps<{matchId:string;kind:'teams'|'players';label:string;initialQuery:string;suggestions?:RosterCatalogueCandidate[]}>();
const model=defineModel<RosterCatalogueCandidate|null>({required:true}),emit=defineEmits<{source:[sha:string|null]}>();
const query=ref(props.initialQuery),items=ref<RosterCatalogueCandidate[]|null>(null),busy=ref(false),error=ref(''),fetchedAt=ref('');
const displayed=computed(()=>items.value??props.suggestions??null);
const preferred=computed(()=>displayed.value&&displayed.value.length>1?preferredHistoryCandidate(displayed.value):null);
async function choose(item:RosterCatalogueCandidate){if(!item.discovery){model.value=item;return;}busy.value=true;error.value='';
 try{const r=await readCatalog(`upcoming/${props.matchId}/catalogue/search`,RosterCatalogueSearchResultSchema,new AbortController().signal,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify({kind:'players',query:item.id})});
  emit('source',r.registrySha256===undefined?r.payloadSha256:r.registrySha256);const verified=r.items.find(p=>p.id===item.id&&!p.discovery);if(!verified)throw Error('Не удалось проверить числовой профиль.');model.value=verified;
 }catch(e){error.value=e instanceof Error?e.message:'Профиль недоступен.';}finally{busy.value=false;}
}
async function search(){busy.value=true;error.value='';items.value=null;
 try{const r=await readCatalog(`upcoming/${props.matchId}/catalogue/search`,RosterCatalogueSearchResultSchema,new AbortController().signal,{method:'POST',
  headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify({kind:props.kind,query:query.value})});
  if(props.kind==='players')emit('source',r.registrySha256===undefined?r.payloadSha256:r.registrySha256);items.value=r.items;fetchedAt.value=r.fetchedAt;if(r.warning)error.value='Часть источников недоступна. Показаны доступные кандидаты; повторите поиск позже.';
 }catch(e){error.value=e instanceof Error?e.message:'Не удалось найти запись.';}finally{busy.value=false;}
}
</script>
<template>
 <section class="source-picker" :aria-label="label">
  <label>{{label}}<input v-model="query" type="search" maxlength="200" @keydown.enter.prevent="search" /></label>
  <p v-if="kind==='players'" class="hint">Поиск по нику, ID аккаунта или ссылке STRATZ, OpenDota, Dotabuff, Steam. Если игрока нет в каталоге, вставьте ссылку на его профиль.</p>
  <button type="button" :disabled="busy||!query.trim()" @click="search">{{busy?'Поиск…':'Найти в OpenDota'}}</button>
  <p v-if="model" class="selected">Выбрано: {{model.name}} · ID {{model.id}}</p>
  <p v-if="model?.localPlayerId" class="hint">Локальный игрок {{model.localPlayerId}} · pro-карт: {{model.proMaps??0}} · известные ники: {{model.aliases?.join(', ')||'нет'}}. {{model.observedAt?`Проверка аккаунта: ${dateLabel(model.observedAt)}`:''}}</p>
  <p v-if="fetchedAt" class="hint">Поиск: {{dateLabel(fetchedAt)}}. До 25 результатов.</p>
  <p v-if="displayed?.length===0">{{kind==='teams'?'Команда не найдена в загруженном справочнике. Попробуйте тег или числовой ID команды OpenDota.':'Совпадений нет. Попробуйте другой ник, числовой ID или ссылку STRATZ на профиль игрока.'}}</p>
  <ul v-if="displayed?.length"><li v-for="item in displayed" :key="item.id">
   <button type="button" :disabled="busy" :aria-pressed="model?.id===item.id" @click="choose(item)">{{item.name}} · ID {{item.id}}</button>
   <span v-if="item.reason" class="hint">{{item.reason}}</span>
   <span v-if="kind==='players'&&item.proMaps!==undefined" class="hint">Локальные pro-карты: {{item.proMaps}}<span v-if="item.proMaps===0"> · история может быть ещё не загружена</span></span>
   <span v-else-if="kind==='players'" class="hint">Локальная pro-история не проверена.</span>
   <span v-if="preferred?.id===item.id" class="hint">Предложен по наличию pro-истории. Проверьте соответствие игроку.</span>
   <span v-if="kind==='players'" class="hint">Команда в источнике: {{item.teamName??'не указана'}}{{item.teamId?` · ID ${item.teamId}`:''}}</span>
   <span v-if="item.profileSha256" class="hint">Аккаунт проверен по отдельному профилю OpenDota. Профиль не подтверждает участие в матче.</span>
  </li></ul>
  <p v-if="error" class="error" role="alert">{{error}}</p>
 </section>
</template>
<style scoped>
.source-picker{margin-block:var(--space-3);overflow-wrap:anywhere}label{display:block}.source-picker ul{padding-left:var(--space-4)}li{margin-block:var(--space-2)}li button{max-width:100%;white-space:normal}li span{display:block}.selected{font-weight:600}input{min-width:0;max-width:100%}
</style>
