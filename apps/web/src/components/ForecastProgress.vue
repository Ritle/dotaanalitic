<script setup lang="ts">
import {computed} from 'vue';
import type {QuickForecastProgress} from '../../../api/src/modules/upcoming/quick-forecast-contract';
const props=defineProps<{progress:QuickForecastProgress|null;busy:boolean;connectionLost:boolean}>();
const steps=[{id:'request',label:'Приём запроса'},{id:'schedule',label:'Проверка и обновление расписания'},
 {id:'lineups',label:'Проверка команд и турнира'},{id:'map',label:'Подтверждённые пятёрки и подготовка карты'},
 {id:'analysis',label:'Анализ pro-истории, расчёт и сохранение'}];
const completed=computed(()=>props.progress?.state==='complete'?steps.length:Math.max(0,steps.findIndex(s=>s.id===props.progress?.stage)));
const status=computed(()=>props.connectionLost?'Связь с сервером потеряна — результат пока не подтверждён.':!props.progress?'Ожидаем подтверждение сервера…':
 props.progress.state==='complete'?'Проверка завершена. Результат сохранён.':props.progress.state==='failed'?'Расчёт остановлен. Причина указана ниже.':steps[completed.value]?.label+'…');
</script>
<template><section class="forecast-progress" aria-label="Ход расчёта">
 <p role="status" aria-live="polite">{{status}}</p>
 <progress :value="progress?completed:undefined" :max="steps.length" aria-label="Завершённые этапы расчёта" :aria-valuetext="progress?`${completed} из ${steps.length} этапов завершено`:'Ожидание сервера'" />
 <p class="hint">{{completed}} из {{steps.length}} этапов завершено. Длительность этапов различается.</p>
 <ol><li v-for="(step,index) in steps" :key="step.id" :class="{done:index<completed,active:progress?.stage===step.id&&busy&&!connectionLost}" :aria-current="progress?.stage===step.id&&busy?'step':undefined">
  <span aria-hidden="true">{{index<completed?'✓':index+1}}</span> {{step.label}}
  <small v-if="index<completed&&progress?.reused&&index>0&&index<3"> — из сохранённой подготовки</small>
 </li></ol>
 <p v-if="progress?.reused" class="hint">Продолжаем сохранённую попытку. Повтор не создаёт второй прогноз.</p>
</section></template>
<style scoped>
.forecast-progress{margin-block:var(--space-4);padding:var(--space-4);background:var(--color-elevated);border-radius:var(--radius-sm);overflow-wrap:anywhere}progress{display:block;width:100%;height:14px;accent-color:var(--color-accent)}ol{list-style:none;padding:0;margin-bottom:0}li{padding-block:6px;color:var(--color-muted)}li.active{color:var(--color-text);font-weight:600}li.done{color:var(--color-text)}li span{display:inline-block;min-width:22px}.hint,small{font-size:12px}
</style>
