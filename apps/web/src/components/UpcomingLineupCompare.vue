<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {CompareRequestSchema,CompareResponseSchema,type CompareRequest} from '@dota/contracts';
import {ownerAuth} from '../auth';
import {readCatalog,dateLabel} from '../catalog';
import CompareStat from './CompareStat.vue';
import SampleNote from './SampleNote.vue';
const props=defineProps<{input:CompareRequest|null}>(),applied=ref<CompareRequest|null>(null);
watch(()=>props.input,()=>{applied.value=null;},{deep:true,flush:'sync'});
const query=useQuery({queryKey:computed(()=>['compare','upcoming',applied.value]),enabled:computed(()=>!!ownerAuth.value&&!!applied.value),
  queryFn:({signal})=>readCatalog('teams/compare',CompareResponseSchema,signal,{method:'POST',
    headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value!.csrfToken},body:JSON.stringify(applied.value)})});
const report=computed(()=>applied.value&&!query.isFetching.value&&!query.isError.value&&query.data.value?.status!=='unavailable'?query.data.value:null);
const columns=computed(()=>report.value?[{slot:'A',team:report.value.teamA},{slot:'B',team:report.value.teamB}]:[]);
function compare(){
  if(!props.input)return;
  const next=CompareRequestSchema.parse(props.input);
  if(JSON.stringify(applied.value)===JSON.stringify(next)){void query.refetch();return;}
  applied.value=next;
}
</script>
<template>
  <section class="lineup-compare" aria-label="Сравнение подтверждённых пятёрок">
    <h3>История выбранных пятёрок</h3>
    <p class="hint">Подтвердите десять игроков и роли, затем запустите сравнение. Последние 90 дней до запроса, все патчи и турниры. История организации и выбранных игроков считается отдельно. Сценарий не сохраняется.</p>
    <button type="button" :disabled="!input||query.isFetching.value" @click="compare">Сравнить выбранные пятёрки</button>
    <p v-if="applied&&query.isFetching.value" role="status">Сравниваем подтверждённые пятёрки…</p>
    <div v-if="applied&&query.isError.value" role="alert"><p class="error">{{query.error.value?.message}}</p><button type="button" @click="query.refetch()">Повторить сравнение пятёрок</button></div>
    <p v-if="applied&&!query.isFetching.value&&!query.isError.value&&query.data.value?.status==='unavailable'" class="warning" role="status">{{query.data.value.message}} Уточните период в полном сравнении организаций.</p>
    <section v-if="report" aria-label="Результат сравнения пятёрок">
      <p>Период: {{dateLabel(report.fromAt)}} → {{dateLabel(report.cutoffAt)}}.</p>
      <p class="hint">Срез БД: {{dateLabel(report.snapshotAt)}} · источник: нормализованные локальные pro-карты · все патчи и турниры · без весов.</p>
      <p class="warning">Малое N не гарантирует надёжности. Наблюдаемый win rate — частота прошлых побед. Прогноз недоступен.</p>
      <div class="lineup-columns"><article v-for="col in columns" :key="col.slot" :aria-label="`Пятёрка ${col.slot}`">
        <h4>{{col.slot}} · {{col.team.name}} · ID {{col.team.organizationId}}</h4>
        <div role="group" :aria-label="`Организация ${col.slot} за период`"><p>История организации за период</p><CompareStat :stats="col.team.organization" /></div>
        <div role="group" :aria-label="`Точная пятёрка ${col.slot} в организации`"><p>Выбранная пятёрка · эта организация</p><CompareStat :stats="col.team.selectedFiveOrganization" /></div>
        <div role="group" :aria-label="`Точная пятёрка ${col.slot} в любых организациях`"><p>Выбранная пятёрка · любые организации</p><CompareStat :stats="col.team.cohesion.actual.exactFive" /></div>
        <SampleNote :evidence="col.team.cohesion.actual.exactFive.sampleEvidence" />
        <p class="hint">Совместные карты: {{dateLabel(col.team.cohesion.actual.exactFive.firstAt)}} — {{dateLabel(col.team.cohesion.actual.exactFive.lastAt)}}. Данные пятёрки обновлены: {{dateLabel(col.team.cohesion.actual.exactFive.dataUpdatedAt)}}.</p>
        <p class="hint">Исторические личности подтверждены для {{col.team.cohesion.actual.players.filter(p=>p.identityStatus==='verified').length}}/5 игроков. Роли выбраны вручную; участие в турнире этим не подтверждается.</p>
        <p v-if="col.team.cohesion.coverage.incompleteSides||col.team.cohesion.coverage.duplicateIdentityMaps||col.team.cohesion.coverage.knownPatchMaps<col.team.cohesion.coverage.eligibleMaps||col.team.cohesion.coverage.lateFetchedMaps||col.team.cohesion.coverage.sourceFetchUnknown" class="warning">Есть пропуски покрытия; подробности раскрыты ниже.</p>
        <details><summary>{{col.slot}} · 10 пар в любых организациях</summary>
          <p class="hint">Одна карта считается один раз для каждой пары. Сумма N десяти пар не равна числу уникальных карт пятёрки.</p>
          <div class="table-scroll"><table :aria-label="`Пары пятёрки ${col.slot}`"><thead><tr><th>Игроки · canonical ID</th><th>Наблюдения</th><th>Последняя карта</th></tr></thead><tbody>
            <tr v-for="(pair,i) in col.team.cohesion.actual.pairs" :key="i"><td>{{pair.playerIds.join(' + ')}}</td><td><CompareStat :stats="pair" /></td><td>{{dateLabel(pair.lastAt)}}</td></tr>
          </tbody></table></div>
        </details>
        <details><summary>{{col.slot}} · Личная история и роли</summary>
          <div v-for="p in col.team.cohesion.actual.players" :key="p.rolePos" class="player-history">
            <p>ID {{p.playerId}} · выбранная роль {{p.rolePos}} <span v-if="p.isStandin">· замена</span></p><CompareStat :stats="p" />
            <p class="hint">Историческая роль подтверждена на {{p.confirmedRoleMaps??'неизвестно'}} картах; совпала с выбранной на {{p.selectedRoleMaps??'неизвестно'}}. Последняя карта: {{dateLabel(p.lastAt)}} · обновлено: {{dateLabel(p.dataUpdatedAt)}}.</p>
          </div>
          <p class="hint">История игрока следует за подтверждённой личностью через переходы между организациями. Замена не означает фиксированного штрафа.</p>
        </details>
        <details><summary>{{col.slot}} · Покрытие и источники пятёрки</summary>
          <p>Допущено карт общего корпуса: {{col.team.cohesion.coverage.eligibleMaps}}; неполных сторон: {{col.team.cohesion.coverage.incompleteSides}}; карт с повторной личностью: {{col.team.cohesion.coverage.duplicateIdentityMaps}}; с проверенным патчем: {{col.team.cohesion.coverage.knownPatchMaps}}.</p>
          <p class="hint">Получены после среза: {{col.team.cohesion.coverage.lateFetchedMaps}}; время получения неизвестно: {{col.team.cohesion.coverage.sourceFetchUnknown}}. Это ретроспективное описание, не доказательство известности состава до начала карты.</p>
          <p v-for="m in col.team.cohesion.provenance" :key="m.matchId" class="hint">{{m.matchId}} · {{m.source}} · обновлено {{dateLabel(m.syncedAt)}} · получено {{dateLabel(m.sourceFetchedAt)}}</p>
        </details>
      </article></div>
      <p class="hint">Общий корпус: {{report.coverage.candidates}} кандидатов; pro неизвестен {{report.coverage.unknownPro}}, непрофессиональных {{report.coverage.nonPro}}, конфликтных {{report.coverage.conflict}}, незавершённых {{report.coverage.unfinished}}. Неизвестные показатели не заменяются нулями.</p>
    </section>
  </section>
</template>
<style scoped>
.lineup-compare{border-top:1px solid var(--color-border);margin-block:var(--space-4);padding-top:var(--space-4);overflow-wrap:anywhere}
.lineup-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);align-items:start}
article{min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-4)}
h4{margin-top:0}summary{cursor:pointer;min-height:44px;padding-block:8px}.player-history{border-bottom:1px solid var(--color-border);padding-block:8px}
table{min-width:480px}th,td{vertical-align:top}
@media(max-width:680px){.lineup-columns{grid-template-columns:1fr}}
</style>
