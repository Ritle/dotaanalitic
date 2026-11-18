<script setup lang="ts">
import {computed} from 'vue';
const props=defineProps<{kind:'patches'|'heroes';id:string|null;labels:Record<string,string>}>();
const key=computed(()=>(props.kind==='patches'?'patch:':'hero:')+props.id);
const label=computed(()=>props.id===null?(props.kind==='patches'?'Патч неизвестен':'Герой неизвестен'):
 Object.hasOwn(props.labels,key.value)?props.labels[key.value]!.trim()||(props.kind==='patches'?'Патч без названия':'Герой без названия'):
 props.kind==='patches'?'Название патча недоступно':'Название героя недоступно');
</script>
<template><span class="analytic-entity" :data-analytic-kind="kind" :data-analytic-id="id??'unknown'">
 <span>{{label}}</span><details v-if="id!==null"><summary>Ключ записи</summary><span>Локальный ID: {{id}}</span></details>
</span></template>
<style scoped>.analytic-entity{display:inline-block;max-width:100%;vertical-align:top;overflow-wrap:anywhere}summary{cursor:pointer;min-height:44px;padding-block:8px;font-size:12px}details{font-weight:normal;font-size:12px}</style>
