<script setup lang="ts">
import {computed,ref} from 'vue';
import type {V1PredictionView} from '@dota/contracts';
import {roleName} from '../role-suggestions';
import {roleSortedRows} from '../role-display';
import CatalogDisplayLabels from './CatalogDisplayLabels.vue';
import ReportEntityLabel from './ReportEntityLabel.vue';
// Display-only structural input: journal entries contain identities, not assigned roles.
const props=withDefaults(defineProps<{input:{teamAId:string;teamBId:string;lineupA:{playerId:string|null;rolePos?:number}[];lineupB:{playerId:string|null;rolePos?:number}[]};
 labelPrefix?:string;showRoles?:boolean;samples?:V1PredictionView['players'];lazy?:boolean}>(),{labelPrefix:'Выбранный состав',lazy:false,showRoles:false});
const open=ref(false);
const players=computed(()=>[...props.input.lineupA,...props.input.lineupB].map(p=>p.playerId));
function toggle(event:Event){if(event.target===event.currentTarget&&event.target instanceof HTMLDetailsElement)open.value=event.target.open;}
</script>
<template>
 <component :is="lazy?'details':'div'" data-forecast-lineups class="forecast-lineups" @toggle="toggle">
  <summary v-if="lazy">{{showRoles?'Подтверждённые игроки и роли':'Команды и ожидаемые составы A/B'}}</summary>
  <CatalogDisplayLabels v-if="!lazy||open" :team-ids="[input.teamAId,input.teamBId]" :player-ids="players" v-slot="{labels}">
   <div class="lineups">
    <section v-for="slot in (['A','B'] as const)" :key="slot" :aria-label="`${labelPrefix} ${slot}`">
     <h3>Команда {{slot}} · <ReportEntityLabel kind="teams" :id="slot==='A'?input.teamAId:input.teamBId" :name="labels['team:'+(slot==='A'?input.teamAId:input.teamBId)]" /></h3>
     <ul><li v-for="(p,index) in (showRoles?roleSortedRows(slot==='A'?input.lineupA:input.lineupB,p=>p.rolePos):(slot==='A'?input.lineupA:input.lineupB))" :key="index">
      <span v-if="showRoles&&p.rolePos">{{roleName(p.rolePos)}} · </span><ReportEntityLabel kind="players" :id="p.playerId" :name="labels['player:'+p.playerId]" />
      <span v-if="samples"> · N={{(slot==='A'?samples.teamA:samples.teamB).find(row=>row.playerId===p.playerId)?.maps??'неизвестно'}}</span>
     </li></ul>
    </section>
   </div>
  </CatalogDisplayLabels>
 </component>
</template>
<style scoped>
.forecast-lineups{min-width:0;overflow-wrap:anywhere}.lineups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4)}
details.forecast-lineups .lineups{grid-template-columns:1fr}h3{font-size:1rem}ul{padding-left:20px}li{margin-block:var(--space-2)}summary{cursor:pointer;min-height:44px;padding-block:8px}
@media(max-width:600px){.lineups{grid-template-columns:1fr}}
</style>
