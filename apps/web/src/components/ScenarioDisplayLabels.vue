<script setup lang="ts">
import {computed} from 'vue';
import type {ScenarioInput} from '@dota/contracts';
import CatalogDisplayLabels from './CatalogDisplayLabels.vue';
const props=defineProps<{input:ScenarioInput}>();
const players=computed(()=>[...props.input.lineupA,...props.input.lineupB,...(props.input.expectedLineupA??[]),...(props.input.expectedLineupB??[])].map(p=>p.playerId));
</script>
<template>
 <CatalogDisplayLabels class="scenario-display-labels" :team-ids="[input.teamAId,input.teamBId]" :player-ids="players" v-slot="{labels}"><slot :labels="labels" /></CatalogDisplayLabels>
</template>
