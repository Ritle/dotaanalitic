<script setup lang="ts">
import {computed} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {RoleSuggestionReportSchema,CatalogIdSchema} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
import {arrangeSuggestedRoles,roleName,type RoleMember} from '../role-suggestions';
const props=defineProps<{lineup:RoleMember[];slot:'A'|'B';cutoffAt?:string}>();
const emit=defineEmits<{apply:[lineup:RoleMember[]]}>();
const ids=computed(()=>props.lineup.map(p=>p.playerId??'').filter(Boolean));
const complete=computed(()=>ids.value.length===5&&new Set(ids.value).size===5&&ids.value.every(id=>CatalogIdSchema.safeParse(id).success));
// A future scenario uses information available now; a historical cutoff remains explicit.
const cutoff=computed(()=>props.cutoffAt&&props.cutoffAt<new Date().toISOString()?props.cutoffAt:undefined);
const query=useQuery({queryKey:computed(()=>['role-suggestions',ids.value.join(':'),cutoff.value??'now']),enabled:complete,
  staleTime:60_000,queryFn:({signal})=>readCatalog('lineup-role-suggestions',RoleSuggestionReportSchema,signal,{method:'POST',
    headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},
    body:JSON.stringify({playerIds:ids.value,cutoffAt:cutoff.value})})});
const report=computed(()=>complete.value?query.data.value:undefined);
const arranged=computed(()=>report.value?arrangeSuggestedRoles(props.lineup,report.value):null);
const reason=(code:string)=>({NO_ELIGIBLE_PRO_HISTORY:'нет подходящей pro-истории',ROLE_COVERAGE_PARTIAL:'неполное покрытие ролей',
  SMALL_SAMPLE:'мало карт',AMBIGUOUS_ROLE:'нет преобладающей позиции',UNVALIDATED_HEURISTIC:'оценка по линии и GPM'}[code]??code);
function apply(){if(arranged.value)emit('apply',arranged.value);}
</script>
<template>
  <section class="role-suggestions" :aria-label="`Автоопределение ролей ${slot}`">
    <h3>Автоопределение ролей {{slot}}</h3>
    <p class="hint">Выберите пять игроков в любом порядке. Подсказки рассчитываются автоматически; ручные правки сохраняются до нажатия «Применить роли». V1 Elo от ролей не зависит.</p>
    <p v-if="!complete">Для подсказки нужны пять разных игроков.</p>
    <p v-else-if="query.isFetching.value" role="status">Определяем позиции по локальной pro-истории…</p>
    <template v-else-if="report">
      <p class="hint">Источник: локальные pro-карты · {{dateLabel(report.fromAt)}} — {{dateLabel(report.cutoffAt)}} · до 20 последних карт игрока. Проверено {{dateLabel(report.snapshotAt)}}.</p>
      <ul><li v-for="p in report.players" :key="p.playerId">
        Игрок {{p.playerId}}: <strong>{{p.suggestedRole===null?'Роль не определена':`${p.suggestedRole} · ${roleName(p.suggestedRole)}`}}</strong>
        <span class="hint"> · карт с оценкой {{p.nUsed}} из {{p.nRaw}}<template v-if="p.suggestedRole!==null"> · за эту позицию {{p.topCount}}</template> · {{p.basis==='confirmed_history'?'по историческим подтверждённым ролям':'предположение'}}<template v-if="p.reasons.length"> · {{p.reasons.map(reason).join('; ')}}</template></span>
      </li></ul>
      <p v-if="report.warnings.includes('DUPLICATE_SUGGESTED_ROLES')" role="status">У нескольких игроков совпала предполагаемая позиция. Расставьте их вручную.</p>
      <p class="hint">Это подсказка для выбранного состава, а не подтверждение роли в будущей игре. Нестандартные линии и смена позиции могут дать ошибку.</p>
      <button type="button" :disabled="!arranged" @click="apply">Применить роли {{slot}}</button>
    </template>
    <p v-if="complete&&query.error.value" role="alert" class="error">{{query.error.value.message}} <button type="button" @click="query.refetch()">Повторить определение ролей {{slot}}</button></p>
  </section>
</template>
<style scoped>
.role-suggestions{margin-block:var(--space-4);padding:var(--space-3);border:1px solid var(--color-border);border-radius:var(--radius-sm);overflow-wrap:anywhere}
h3{font-size:16px}ul{padding-left:var(--space-4)}li{margin-block:var(--space-2)}
</style>
