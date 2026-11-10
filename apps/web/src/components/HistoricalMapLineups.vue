<script setup lang="ts">
import {ref} from 'vue';
import CatalogDisplayLabels from './CatalogDisplayLabels.vue';
import ReportEntityLabel from './ReportEntityLabel.vue';
defineProps<{matchId:string;lineupA:Array<string|null>;lineupB:Array<string|null>;teamAName:string;teamBName:string}>();
const open=ref(false);
</script>
<template>
 <details :aria-label="`Составы карты ${matchId}`" @toggle="open=($event.currentTarget as HTMLDetailsElement).open">
  <summary>Составы A / B</summary>
  <CatalogDisplayLabels v-if="open" :player-ids="[...lineupA,...lineupB]" v-slot="{labels}">
   <p class="hint">Фактические участники этой исторической карты. Порядок списка не задаёт роли.</p>
   <section v-for="slot in (['A','B'] as const)" :key="slot" :aria-label="`Фактическая пятёрка ${slot}`">
    <h4>{{slot}} · {{(slot==='A'?teamAName:teamBName).trim()||'Команда без названия'}}</h4>
    <ul><li v-for="(id,index) in (slot==='A'?lineupA:lineupB)" :key="index"><ReportEntityLabel kind="players" :id="id" :name="labels['player:'+id]" /></li></ul>
   </section>
  </CatalogDisplayLabels>
 </details>
</template>
<style scoped>summary{cursor:pointer;min-height:44px;padding-block:10px}ul{padding-left:20px}li{margin-block:8px}h4{margin-bottom:8px}</style>
