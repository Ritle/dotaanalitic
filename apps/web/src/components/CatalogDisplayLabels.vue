<script setup lang="ts">
import {computed} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {DisplayLabelsSchema} from '../../../api/src/modules/catalog/display-labels-contract';
import {readCatalog,dateLabel} from '../catalog';
const props=defineProps<{teamIds?:Array<string|null>;playerIds?:Array<string|null>;heroIds?:Array<string|null>;compact?:boolean}>();
const unique=(ids:Array<string|null>|undefined)=>[...new Set((ids??[]).filter((id):id is string=>id!==null))].sort();
const ids=computed(()=>{const heroes=unique(props.heroIds);return {teams:unique(props.teamIds),players:unique(props.playerIds),...(heroes.length?{heroes}:{})};});
const hasIds=computed(()=>ids.value.teams.length+ids.value.players.length+(ids.value.heroes?.length??0)>0);
const query=useQuery({queryKey:computed(()=>['catalog-display-labels',ids.value]),enabled:hasIds,staleTime:300000,retry:false,refetchOnWindowFocus:false,
 queryFn:({signal})=>readCatalog(`catalog-labels?${new URLSearchParams({teams:ids.value.teams.join(','),players:ids.value.players.join(','),...(ids.value.heroes?{heroes:ids.value.heroes.join(',')}:{})})}`,DisplayLabelsSchema,signal)});
const labels=computed<Record<string,string>>(()=>{
 const result:Record<string,string>={};
 for(const p of query.data.value?.teams??[])result['team:'+p.id]=p.name;
 for(const p of query.data.value?.players??[])result['player:'+p.id]=p.name;
 for(const h of query.data.value?.heroes??[])result['hero:'+h.id]=h.name;
 return result;
});
</script>
<template>
 <div class="catalog-display-labels" :class="{compact}">
  <component :is="compact?'details':'div'" class="label-metadata">
  <summary v-if="compact">Подписи каталога</summary>
  <p class="hint">Дополнительные подписи — из текущего локального каталога, не на дату карты. Имена не меняют статистику или выбранный состав.</p>
  <p v-if="!hasIds" class="hint">Известных записей для чтения подписей нет.</p>
  <p v-if="query.isFetching.value" role="status">Чтение подписей каталога…</p>
  <p v-else-if="query.error.value" role="status" class="warning">Не удалось обновить подписи каталога. Исходные данные сохранены; записи можно проверить по ссылкам.</p>
  <p v-if="query.data.value" class="hint">Подписи прочитаны: {{dateLabel(query.data.value.readAt)}}.</p>
  <button type="button" :disabled="!hasIds||query.isFetching.value" @click="query.refetch()">Обновить подписи каталога</button>
  </component>
  <p v-if="compact&&query.error.value" role="status" class="warning">Названия недоступны; выбранные записи сохранены.</p>
  <slot :labels="labels" />
 </div>
</template>

<style scoped>.compact{display:flex;flex-direction:column}.compact>.label-metadata{order:2;margin:0}.label-metadata>summary{cursor:pointer;font-size:12px;color:var(--color-muted);min-height:28px;padding-block:4px}</style>
