<script setup lang="ts">
defineProps<{stats:{nRaw:number|null;wins:number|null;winRate:number|null}|null}>();
const rate=(n:number|null)=>n===null?'неизвестно':new Intl.NumberFormat('ru-RU',{style:'percent',maximumFractionDigits:1}).format(n);
</script>
<template><div v-if="stats"><strong>{{rate(stats.winRate)}}</strong><br />N = {{stats.nRaw??'неизвестно'}} · побед {{stats.wins??'неизвестно'}}</div><span v-else>Недоступно</span></template>
