<script setup lang="ts">
import {computed} from 'vue';
import {forecastVerdict,type ForecastVerdictInput} from '../forecast-verdict';
import {metricLabel} from '../journal';
const props=defineProps<{input:ForecastVerdictInput;teamAName?:string|null;teamBName?:string|null}>();
const verdict=computed(()=>forecastVerdict(props.input));
const favourite=computed(()=>props.input.calculationStatus!=='done'||props.input.probability===null||props.input.probability===0.5?null:props.input.probability>0.5?'A':'B');
const winner=computed(()=>['primary','superseded','eligible','excluded'].includes(props.input.status)?props.input.actualWinner:null);
const team=(side:'A'|'B')=>`${side} · ${(side==='A'?props.teamAName:props.teamBName)?.trim()||'Название неизвестно'}`;
</script>
<template>
 <section class="verdict" :class="verdict.tone" aria-label="Итог проверки прогноза" :data-verdict="verdict.kind">
  <h3><span aria-hidden="true">{{verdict.kind==='correct'?'✓':verdict.kind==='incorrect'?'✕':verdict.tone==='warning'?'◷':'—'}}</span> {{verdict.label}}</h3>
  <div class="comparison">
   <p><span>Прогнозировали победу</span><strong>{{favourite?team(favourite):'Фаворит не выбран'}}</strong>
    <small v-if="favourite&&input.probability!==null">{{metricLabel(favourite==='A'?input.probability:1-input.probability,true)}} на момент расчёта (округлено)</small></p>
   <p><span>{{input.sourceChangedSinceRefresh?'Победитель в сохранённой сверке':'Фактически победила'}}</span><strong>{{winner?team(winner):'Результат не подтверждён'}}</strong></p>
  </div>
  <p class="explanation">{{verdict.detail}}</p>
 </section>
</template>
<style scoped>
.verdict{border:1px solid var(--color-border);border-left:5px solid var(--color-muted);border-radius:var(--radius-sm);padding:var(--space-4);background:var(--color-bg);min-width:0;overflow-wrap:anywhere}
h3{margin:0 0 var(--space-3);font-size:1.15rem}.success{border-left-color:var(--color-success)}.success h3{color:var(--color-success)}
.danger{border-left-color:var(--color-danger)}.danger h3{color:var(--color-danger)}.warning{border-left-color:var(--color-warning)}.warning h3{color:var(--color-warning)}
.comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4)}p{margin:0}.comparison p{display:grid;align-content:start;gap:var(--space-1)}
.comparison span,small,.explanation{color:var(--color-muted);font-size:.875rem}.explanation{margin-top:var(--space-3)}
@media(max-width:480px){.comparison{grid-template-columns:1fr}}
</style>
