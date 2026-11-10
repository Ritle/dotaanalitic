<script setup lang="ts">
import {computed} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {DisplayLabelsSchema} from '../../../api/src/modules/catalog/display-labels-contract';
import {readCatalog,dateLabel} from '../catalog';
const props=defineProps<{teamIds?:Array<string|null>;playerIds?:Array<string|null>}>();
const unique=(ids:Array<string|null>|undefined)=>[...new Set((ids??[]).filter((id):id is string=>id!==null))].sort();
const ids=computed(()=>({teams:unique(props.teamIds),players:unique(props.playerIds)}));
const hasIds=computed(()=>ids.value.teams.length+ids.value.players.length>0);
const query=useQuery({queryKey:computed(()=>['catalog-display-labels',ids.value]),enabled:hasIds,staleTime:300000,retry:false,refetchOnWindowFocus:false,
 queryFn:({signal})=>readCatalog(`catalog-labels?${new URLSearchParams({teams:ids.value.teams.join(','),players:ids.value.players.join(',')})}`,DisplayLabelsSchema,signal)});
const labels=computed<Record<string,string>>(()=>{
 const result:Record<string,string>={};
 for(const p of query.data.value?.teams??[])result['team:'+p.id]=p.name;
 for(const p of query.data.value?.players??[])result['player:'+p.id]=p.name;
 return result;
});
</script>
<template>
 <div class="catalog-display-labels">
  <p class="hint">Дополнительные подписи — из текущего локального каталога, не на дату карты. Имена не меняют статистику или выбранный состав.</p>
  <p v-if="!hasIds" class="hint">Известных записей для чтения подписей нет.</p>
  <p v-if="query.isFetching.value" role="status">Чтение подписей каталога…</p>
  <p v-else-if="query.error.value" role="status" class="warning">Не удалось обновить подписи каталога. Исходные данные сохранены; записи можно проверить по ссылкам.</p>
  <p v-if="query.data.value" class="hint">Подписи прочитаны: {{dateLabel(query.data.value.readAt)}}.</p>
  <button type="button" :disabled="!hasIds||query.isFetching.value" @click="query.refetch()">Обновить подписи каталога</button>
  <slot :labels="labels" />
 </div>
</template>
