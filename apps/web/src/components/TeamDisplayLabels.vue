<script setup lang="ts">
import {computed} from 'vue';
import {useQueries} from '@tanstack/vue-query';
import {ContextCatalogSchema} from '../../../api/src/modules/catalog/context-catalog-contract';
import {teamLabelBatches} from '../team-label-batches';
import {readCatalog,dateLabel} from '../catalog';
const props=defineProps<{teamIds:(string|null)[]}>(),schema=ContextCatalogSchema.refine(v=>v.kind==='teams');
const batches=computed(()=>teamLabelBatches(props.teamIds));
const results=useQueries({queries:computed(()=>batches.value.map(ids=>({queryKey:['context-catalog','team-label-batch',ids],staleTime:300000,retry:false,refetchOnWindowFocus:false,
 queryFn:({signal}:{signal:AbortSignal})=>readCatalog(`context-catalog?${new URLSearchParams({kind:'teams',ids:ids.join(',')})}`,schema,signal)})))});
const labels=computed<Record<string,string>>(()=>Object.fromEntries(results.value.flatMap(q=>(q.data?.items??[]).map(item=>['team:'+item.id,item.name]))));
const loading=computed(()=>results.value.some(q=>q.isFetching)),failed=computed(()=>results.value.some(q=>q.isError));
const times=computed(()=>[...new Set(results.value.flatMap(q=>q.data?[dateLabel(q.data.readAt)]:[]))]);
function refresh(failedOnly=false){for(const q of results.value)if(!failedOnly||q.isError)void q.refetch();}
</script>
<template><div class="team-display-labels">
 <p class="hint">Названия соперников — из текущего локального каталога, не на дату карт. Имена не меняют исторический рейтинг или выборку.</p>
 <p v-if="loading" role="status">Чтение названий команд…</p>
 <p v-if="failed" role="status" class="warning">Часть названий команд недоступна. Рейтинги сохранены; записи можно проверить по ID.</p>
 <p v-if="times.length" class="hint">Названия прочитаны: {{times.join('; ')}}.</p>
 <p v-if="!batches.length" class="hint">Известных организаций для чтения названий нет.</p>
 <button type="button" :disabled="loading||!batches.length" @click="refresh()">Обновить названия команд</button>
 <button v-if="failed" type="button" :disabled="loading" @click="refresh(true)">Повторить недоступные названия</button>
 <slot :labels="labels" />
</div></template>
