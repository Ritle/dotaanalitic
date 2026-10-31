<script setup lang="ts">
import type {HeroPairStat} from '@dota/contracts';
defineProps<{pair:HeroPairStat}>();
const rate=(n:number|null)=>n===null?'нет данных':`${(n*100).toFixed(1)}%`;
const reasons:Record<string,string>={CONTEXT_NOT_SPECIFIC:'неизвестный или смешанный патч',TARGET_SERIES_UNVERIFIED:'серия карты не подтверждена',NO_COMPARABLE_REFERENCE_MAPS:'нет сопоставимых ранних карт',REFERENCE_HAS_ONLY_ONE_OUTCOME:'в ранних картах только один исход',REFERENCE_TOO_LARGE:'раннее окно превышает лимит'};
</script>
<template>
  <div class="pair-value"><strong>WR {{rate(pair.winRate)}}</strong><span>N={{pair.nRaw}} · побед {{pair.wins}}</span>
    <span v-if="pair.sampleEvidence.smallSample" class="warning">Малая выборка</span>
    <span>Сглаженный: {{rate(pair.smoothing.estimate)}}{{pair.smoothing.priorOnly?' · только ранняя выборка':''}}</span>
    <details><summary>Выборка и оценка</summary>
      <p>Патчи: {{pair.patchDistribution.map(p=>`${p.patchId??'неизвестен'}: ${p.nRaw}`).join(', ')||'нет карт'}}.</p>
      <p v-if="pair.smoothing.prior">Ранняя опорная выборка: N={{pair.smoothing.prior.mass}}, среднее {{rate(pair.smoothing.prior.mean)}}. Это описательная оценка без подтверждённой калибровки.</p>
      <p v-else>Сглаживание недоступно: {{reasons[pair.smoothing.reason??'']??pair.smoothing.reason}}.</p>
    </details>
    <template v-if="pair.weighted.status!=='disabled'"><span>Эксперимент с весами: {{rate(pair.weighted.rate)}} · N_eff={{pair.weighted.nEff?.toFixed(2)??'нет данных'}}</span>
      <span>Вес известен {{pair.weighted.nKnown}} / {{pair.nRaw}}; положительный {{pair.weighted.nPositive}}; отсутствует {{pair.weighted.nMissing}}.</span>
      <span v-if="pair.weighted.patchColdStart" class="warning">Нет карт целевого патча</span>
      <span v-if="pair.weighted.status==='unavailable'" class="warning">Недостаточно подтверждений для весов или нет положительного веса.</span>
    </template>
  </div>
</template>
<style scoped>.pair-value{display:grid;gap:6px;min-width:165px;font-size:13px}.pair-value p{overflow-wrap:anywhere}summary{cursor:pointer;min-height:32px}</style>
