<script setup lang="ts">
import AnalyticEntityLabel from './AnalyticEntityLabel.vue';
defineProps<{rows:({patchId:string|null}&({maps:number}|{nRaw:number;wins?:number}))[];labels:Record<string,string>;showWins?:boolean;emptyLabel?:string}>();
</script>
<template><span class="patch-distribution"><span v-if="!rows.length">{{emptyLabel??'нет карт'}}</span><span v-for="(row,i) in rows" :key="i" class="patch-count" :data-distribution-patch="row.patchId??'unknown'">
 <AnalyticEntityLabel kind="patches" :id="row.patchId" :labels="labels" /> — <span data-patch-count>{{'maps' in row?row.maps:row.nRaw}}<template v-if="showWins&&'wins' in row"> / {{row.wins}}</template></span>
</span></span></template>
<style scoped>.patch-distribution{display:inline-flex;flex-wrap:wrap;gap:8px 16px;max-width:100%;vertical-align:top}.patch-count{display:inline-block;max-width:100%;overflow-wrap:anywhere}</style>
