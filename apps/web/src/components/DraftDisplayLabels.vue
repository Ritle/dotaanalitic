<script setup lang="ts">
import CatalogDisplayLabels from './CatalogDisplayLabels.vue';
defineProps<{providedLabels?:Record<string,string>;heroIds?:string[];playerIds?:(string|null)[];teamIds?:(string|null)[];compact?:boolean}>();
</script>
<template>
 <slot v-if="providedLabels!==undefined" :labels="providedLabels" />
 <CatalogDisplayLabels v-else-if="heroIds?.length||playerIds?.some(Boolean)||teamIds?.some(Boolean)" :team-ids="teamIds" :compact="compact" :hero-ids="heroIds" :player-ids="playerIds" v-slot="{labels}"><slot :labels="labels" /></CatalogDisplayLabels>
 <slot v-else :labels="{} as Record<string,string>" />
</template>
