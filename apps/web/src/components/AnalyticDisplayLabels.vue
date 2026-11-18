<script setup lang="ts">
import {computed} from 'vue';
import {useQueries} from '@tanstack/vue-query';
import {ContextCatalogSchema} from '../../../api/src/modules/catalog/context-catalog-contract';
import {analyticLabelBatches} from '../analytic-label-batches';
import {readCatalog,dateLabel} from '../catalog';
const props=defineProps<{patchIds:(string|null)[];heroIds?:string[]}>();
const plan=computed(()=>analyticLabelBatches(props.patchIds,props.heroIds??[]));
const results=useQueries({queries:computed(()=>plan.value.batches.map(({kind,ids})=>({
 queryKey:['context-catalog','analytic-label-batch',kind,ids],staleTime:300000,retry:false,refetchOnWindowFocus:false,
 queryFn:({signal}:{signal:AbortSignal})=>readCatalog(`context-catalog?${new URLSearchParams({kind,ids:ids.join(',')})}`,ContextCatalogSchema.refine(v=>v.kind===kind),signal)
})))});
const labels=computed<Record<string,string>>(()=>Object.fromEntries(results.value.flatMap(q=>(q.data?.items??[]).map(i=>[(q.data!.kind==='patches'?'patch:':'hero:')+i.id,i.name]))));
const loading=computed(()=>results.value.some(q=>q.isFetching)),failed=computed(()=>results.value.some(q=>q.isError));
const times=computed(()=>[...new Set(results.value.flatMap(q=>q.data?[dateLabel(q.data.readAt)]:[]))]);
function refresh(failedOnly=false){for(const q of results.value)if(!failedOnly||q.isError)void q.refetch();}
</script>
<template><div class="analytic-display-labels">
 <template v-if="plan.batches.length">
  <p class="hint">Подписи аналитики — из текущего локального каталога, не на дату карт. Они не меняют выборку, prior или веса.</p>
  <p v-if="loading" role="status">Чтение подписей аналитики…</p>
  <p v-if="failed" role="status" class="warning">Часть подписей аналитики недоступна. Числа сохранены; точные ключи доступны в подробностях.</p>
  <p v-if="times.length" class="hint">Подписи аналитики прочитаны: {{times.join('; ')}}.</p>
  <button type="button" :disabled="loading" @click="refresh()">Обновить подписи аналитики</button>
  <button v-if="failed" type="button" :disabled="loading" @click="refresh(true)">Повторить недоступные подписи аналитики</button>
 </template>
 <p v-if="plan.omitted" class="warning">Лимит чтения названий: без запроса ещё {{plan.omitted}} записей. Их числа и ключи сохранены.</p>
 <slot :labels="labels" />
</div></template>
