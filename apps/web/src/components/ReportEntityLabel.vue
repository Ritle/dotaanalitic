<script setup lang="ts">
import {computed} from 'vue';
// Display metadata only: no fetching, identity resolution or report mutation.
const props=defineProps<{kind:'teams'|'players';id:string|null;name?:string|null}>();
const label=computed(()=>!props.id?(props.kind==='players'?'Игрок не указан':'Команда не указана'):
  props.name==null?'Имя недоступно':props.name.trim()||(props.kind==='players'?'Игрок без ника':'Команда без названия'));
</script>
<template>
  <div class="report-entity">
    <RouterLink v-if="id" :to="`/${kind}/${encodeURIComponent(id)}`" target="_blank" rel="noopener noreferrer">{{label}}</RouterLink>
    <span v-else>{{label}}</span>
    <details v-if="id"><summary>Данные записи</summary><span>Внутренний ID: {{id}}</span></details>
  </div>
</template>
<style scoped>
.report-entity{display:inline-block;max-width:100%;vertical-align:top;overflow-wrap:anywhere}
summary{cursor:pointer;min-height:44px;padding-block:8px;font-size:12px;font-weight:normal;color:var(--color-muted)}
details span{font-size:12px;font-weight:normal}
</style>
