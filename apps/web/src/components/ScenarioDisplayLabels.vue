<script setup lang="ts">
import {computed} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import type {ScenarioInput} from '@dota/contracts';
import {DisplayLabelsSchema} from '../../../api/src/modules/catalog/display-labels-contract';
import {readCatalog,dateLabel} from '../catalog';
const props=defineProps<{input:ScenarioInput}>();
const ids=computed(()=>({teams:[...new Set([props.input.teamAId,props.input.teamBId])].sort(),
 players:[...new Set([...props.input.lineupA,...props.input.lineupB,...props.input.expectedLineupA??[],...props.input.expectedLineupB??[]].flatMap(p=>p.playerId?[p.playerId]:[]))].sort()}));
const query=useQuery({queryKey:computed(()=>['scenario-display-labels',ids.value]),staleTime:300000,retry:false,refetchOnWindowFocus:false,
 queryFn:({signal})=>readCatalog(`catalog-labels?${new URLSearchParams({teams:ids.value.teams.join(','),players:ids.value.players.join(',')})}`,DisplayLabelsSchema,signal)});
const labels=computed(()=>Object.fromEntries([
 ...query.data.value?.teams.map(p=>['team:'+p.id,p.name])??[],...query.data.value?.players.map(p=>['player:'+p.id,p.name])??[]]));
</script>
<template>
 <div class="scenario-display-labels">
  <p class="hint">Дополнительные подписи — из текущего локального каталога, не на дату карты. Сохранённый снимок и его показатели не изменяются.</p>
  <p v-if="query.isFetching.value" role="status">Чтение подписей каталога…</p>
  <p v-else-if="query.error.value" role="status" class="warning">Не удалось обновить подписи каталога. Исходные данные сохранены; записи можно проверить по ссылкам.</p>
  <p v-if="query.data.value" class="hint">Подписи прочитаны: {{dateLabel(query.data.value.readAt)}}.</p>
  <button type="button" :disabled="query.isFetching.value" @click="query.refetch()">Обновить подписи каталога</button>
  <slot :labels="labels" />
 </div>
</template>
