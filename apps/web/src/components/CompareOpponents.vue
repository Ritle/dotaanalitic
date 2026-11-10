<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import type {CompareReport} from '@dota/contracts';
import CatalogDisplayLabels from './CatalogDisplayLabels.vue';
import ReportEntityLabel from './ReportEntityLabel.vue';
import CompareStat from './CompareStat.vue';
const props=defineProps<{slot:string;opponents:CompareReport['teamA']['opponents']}>(),open=ref(false),page=ref(0);
const visible=computed(()=>props.opponents.slice(page.value*2,page.value*2+2));
watch(()=>props.opponents,()=>{page.value=0;});
</script>
<template>
 <details :aria-label="`Соперники команды ${slot}`" @toggle="open=($event.currentTarget as HTMLDetailsElement).open">
  <summary>{{slot}} · Соперники за период</summary>
  <template v-if="open">
   <p v-if="!opponents.length">Соперники за этот период не найдены.</p>
   <template v-else>
    <p>Показаны {{page*2+1}}–{{page*2+visible.length}} из {{opponents.length}}. N каждой строки относится ко всему выбранному периоду.</p>
    <CatalogDisplayLabels :team-ids="visible.map(op=>op.opponentId)" v-slot="{labels}">
     <div v-for="op in visible" :key="op.opponentId??'unknown'" class="opponent"><ReportEntityLabel kind="teams" :id="op.opponentId" :name="labels['team:'+op.opponentId]" /><CompareStat :stats="op.stats" /></div>
    </CatalogDisplayLabels>
    <div class="pagination"><button type="button" :disabled="page===0" @click="page--">Предыдущие соперники</button><button type="button" :disabled="(page+1)*2>=opponents.length" @click="page++">Следующие соперники</button></div>
   </template>
  </template>
 </details>
</template>
<style scoped>summary{cursor:pointer;min-height:44px;padding-block:10px}.opponent{border-bottom:1px solid var(--color-border);padding-block:12px}.pagination{display:flex;gap:8px;flex-wrap:wrap;margin-block:16px}</style>
