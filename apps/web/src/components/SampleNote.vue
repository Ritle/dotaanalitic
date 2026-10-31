<script setup lang="ts">
import type {SampleEvidence} from '@dota/contracts';
defineProps<{evidence:SampleEvidence}>();
const labels:Record<SampleEvidence['band'],string>={unknown:'Размер выборки неизвестен',empty:'Нет наблюдений',under_10:'Менее 10 карт',
  '10_to_29':'От 10 до 29 карт','30_or_more':'30 карт и более'};
</script>
<template><p class="hint sample-note" :class="{'warning':evidence.smallSample||evidence.band==='unknown'}">
  {{labels[evidence.band]}}. <span v-if="evidence.coldStart">Холодный старт по данным.</span>
  Категория объёма не является гарантией надёжности. Веса не применялись; N_eff не рассчитывается.
</p></template>
