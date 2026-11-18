<script setup lang="ts">
import {computed} from 'vue';
import type {ScenarioInput} from '@dota/contracts';
import CatalogDisplayLabels from './CatalogDisplayLabels.vue';
const props=defineProps<{input:ScenarioInput;includeHeroes?:boolean}>();
const players=computed(()=>[...props.input.lineupA,...props.input.lineupB,...(props.input.expectedLineupA??[]),...(props.input.expectedLineupB??[])].map(p=>p.playerId));
const heroes=computed(()=>props.includeHeroes&&props.input.draft?[...props.input.draft.assignments,...props.input.draft.bans].map(h=>String(h.heroId)):undefined);
</script>
<template>
 <CatalogDisplayLabels class="scenario-display-labels" :team-ids="[input.teamAId,input.teamBId]" :player-ids="players" :hero-ids="heroes" v-slot="{labels}"><slot :labels="labels" /></CatalogDisplayLabels>
</template>
