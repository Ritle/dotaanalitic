<script setup lang="ts">
import type {Smoothing} from '@dota/contracts';
import {dateLabel} from '../catalog';
defineProps<{data:Smoothing;compact?:boolean}>();
const rate=(n:number|null)=>n===null?'неизвестно':new Intl.NumberFormat('ru-RU',{style:'percent',maximumFractionDigits:1}).format(n);
const reasons:Record<string,string>={CONTEXT_NOT_SPECIFIC:'Нужны один герой, подтверждённая позиция и один проверенный патч.',TARGET_SERIES_UNVERIFIED:'Серии выбранных карт не подтверждены.',
  NO_COMPARABLE_REFERENCE_MAPS:'Нет сопоставимых ранних карт.',REFERENCE_HAS_ONLY_ONE_OUTCOME:'В раннем пуле только один тип исхода.',
  GLOBAL_REFERENCE_TOO_LARGE:'Ранний пул превышает допустимый объём.',REFERENCE_NOT_LOADED:'Ранний пул не загружен.'};
const reason=(code:string)=>reasons[code]??'Сопоставимая ранняя выборка недоступна.';
</script>
<template><div class="smoothing-note" :role="compact?undefined:'group'" :aria-label="compact?undefined:'Сглаженная историческая оценка'">
  <template v-if="data.status==='available'&&data.prior">
    <p><span v-if="!compact">Сглаженная оценка частоты: </span><strong>{{rate(data.smoothedObservedRate)}}</strong><span v-if="data.priorOnly"> · только исходная оценка пула, новых наблюдений нет</span></p>
    <p class="hint">Исходная частота {{rate(data.prior.mean)}} · объём prior {{data.prior.mass}} карт<span v-if="!compact"> · до {{dateLabel(data.prior.beforeAt)}} · герой {{data.prior.heroId}}, позиция {{data.prior.rolePos}}, патч {{data.prior.patchId}}</span>.</p>
    <p v-if="!compact" class="warning">Экспериментальная оценка исторической частоты, без прогноза следующей карты. Масса prior равна объёму раннего сопоставимого пула; качество не валидировано.</p>
  </template>
  <p v-else class="hint">Сглаживание недоступно. {{data.reasons.map(reason).join(' ')}}</p>
</div></template>
