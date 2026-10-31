<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {useQuery} from '@tanstack/vue-query';
import {CompareRequestSchema,CompareResponseSchema,type CompareRequest} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
import CompareStat from '../components/CompareStat.vue';
const route=useRoute(),router=useRouter(),teamA=ref(typeof route.query.teamA==='string'?route.query.teamA:''),teamB=ref(typeof route.query.teamB==='string'?route.query.teamB:'');
const five=()=>Array.from({length:5},(_,i)=>({playerId:'',rolePos:i+1,isStandin:false}));
const a=ref(five()),b=ref(five()),from=ref(''),cutoff=ref(''),patch=ref(''),league=ref(''),validation=ref(''),applied=ref<CompareRequest|null>(null);
watch([teamA,teamB,a,b,from,cutoff,patch,league],()=>{applied.value=null;validation.value='';},{deep:true});
const {data,isFetching,isError,error,refetch}=useQuery({queryKey:computed(()=>['compare',applied.value]),enabled:computed(()=>!!ownerAuth.value&&applied.value!==null),
  queryFn:({signal})=>readCatalog('teams/compare',CompareResponseSchema,signal,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value!.csrfToken},body:JSON.stringify(applied.value)})});
const report=computed(()=>applied.value&&data.value?.status!=='unavailable'?data.value:null);
const columns=computed(()=>report.value?[{slot:'A',team:report.value.teamA},{slot:'B',team:report.value.teamB}]:[]);
const number=(n:number|null)=>n===null?'неизвестно':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(n);
async function submit(){
  try{
    const time=(s:string)=>s?new Date(s+'Z').toISOString():undefined,players=(rows:ReturnType<typeof five>)=>rows.map(p=>({...p,playerId:p.playerId.trim()||null}));
    const result=CompareRequestSchema.safeParse({teamAId:teamA.value.trim(),teamBId:teamB.value.trim(),lineupA:players(a.value),lineupB:players(b.value),
      fromAt:time(from.value),cutoffAt:time(cutoff.value),patchId:patch.value.trim()||undefined,leagueId:league.value.trim()||undefined});
    if(!result.success)throw new Error('invalid_compare_input');validation.value='';
    if(JSON.stringify(applied.value)===JSON.stringify(result.data)){void refetch();return;}
    applied.value=result.data;await router.replace({path:'/compare',query:{teamA:result.data.teamAId,teamB:result.data.teamBId}});
  }catch{validation.value='Укажите две разные организации, разные canonical ID игроков, роли 1–5 и корректный период UTC. Неизвестные ID игроков оставьте пустыми.';}
}
</script>
<template>
  <section class="panel" aria-labelledby="compare-title">
    <RouterLink to="/">← К справочникам</RouterLink><p class="eyebrow">Две команды · одна карта</p><h2 id="compare-title">Сравнение команд</h2>
    <p>История организаций, выбранных пятёрок и личные встречи считаются отдельно. A/B не означают Radiant/Dire.</p>
    <form @submit.prevent="submit">
      <div class="compare-columns"><fieldset v-for="slot in ['A','B']" :key="slot"><legend>Команда {{slot}}</legend>
        <label :for="'compare-team-'+slot">ID организации<input :id="'compare-team-'+slot" :value="slot==='A'?teamA:teamB" @input="slot==='A'?teamA=($event.target as HTMLInputElement).value:teamB=($event.target as HTMLInputElement).value" :aria-label="`Команда ${slot}: ID организации`" inputmode="numeric" /></label>
        <div v-for="member in (slot==='A'?a:b)" :key="member.rolePos" class="roster-row">
          <label>{{slot}} · роль {{member.rolePos}}<input v-model="member.playerId" :aria-label="`${slot}: игрок роли ${member.rolePos}`" inputmode="numeric" placeholder="ID или неизвестен" /></label>
          <label class="check-label"><input v-model="member.isStandin" type="checkbox" :aria-label="`${slot}: stand-in роли ${member.rolePos}`" /> Stand-in</label>
        </div>
      </fieldset></div>
      <p class="hint">Пятёрки и роли задаются вручную. Это вариант состава, а не подтверждение участия. ID — из локальных справочников; сценарий не сохраняется.</p>
      <div class="map-filters compare-filters"><label>Начало истории, UTC<input v-model="from" type="datetime-local" aria-label="Сравнение: начало UTC" /></label>
        <label>Срез истории, UTC<input v-model="cutoff" type="datetime-local" aria-label="Сравнение: срез UTC" /></label>
        <label>ID патча · пусто = все<input v-model="patch" inputmode="numeric" aria-label="Сравнение: ID патча" /></label>
        <label>ID лиги · пусто = все<input v-model="league" inputmode="numeric" aria-label="Сравнение: ID лиги" /></label></div>
      <p class="hint">Без дат: последние 90 дней до запроса. Начало карты строго раньше среза, карта должна завершиться к нему. Сырые показатели не взвешены.</p>
      <p v-if="validation" class="error" role="alert">{{validation}}</p><button type="submit" :disabled="isFetching">{{isFetching?'Сравнение…':'Сравнить команды'}}</button>
    </form>
    <p v-if="applied&&isFetching" role="status">Читаем историю команд…</p>
    <div v-if="applied&&isError" role="alert"><p class="error">{{error?.message}}</p><button @click="refetch()">Повторить сравнение</button></div>
    <p v-if="applied&&data?.status==='unavailable'" class="warning" role="status">{{data.message}}</p>
  </section>
  <section v-if="report" class="panel" aria-label="Результат сравнения">
    <p>Период: {{dateLabel(report.fromAt)}} → {{dateLabel(report.cutoffAt)}}. Патч-фильтр: {{report.input.patchId??'все'}}; лига: {{report.input.leagueId??'все'}}.</p>
    <p>Срез БД: {{dateLabel(report.snapshotAt)}} · источник: локальные pro-карты. Патч на дату среза: {{report.currentPatchId??'не подтверждён'}}.</p>
    <p class="warning">Победы организации не означают силу нынешней пятёрки. Малое N не гарантирует надёжности. Вероятность победы недоступна.</p>
    <p class="hint">Проценты ниже — наблюдаемый win rate, рядом указан N. Таблицы можно прокручивать вбок.</p>
    <div class="table-scroll"><table aria-label="Показатели двух команд" class="compare-table"><thead><tr><th>Выборка</th><th v-for="col in columns" :key="col.slot">{{col.slot}} · {{col.team.name}}<span class="catalog-id">ID {{col.team.organizationId}}</span></th></tr></thead><tbody>
      <tr><th>Организация · весь период</th><td v-for="col in columns" :key="col.slot"><CompareStat :stats="col.team.organization" /></td></tr>
      <tr><th>Организация · последние 20 карт периода</th><td v-for="col in columns" :key="col.slot"><CompareStat :stats="col.team.recent" /></td></tr>
      <tr><th>Организация · патч на дату среза</th><td v-for="col in columns" :key="col.slot"><CompareStat :stats="col.team.currentPatch" /></td></tr>
      <tr><th>Организация · Radiant</th><td v-for="col in columns" :key="col.slot"><CompareStat :stats="col.team.sides.radiant" /></td></tr>
      <tr><th>Организация · Dire</th><td v-for="col in columns" :key="col.slot"><CompareStat :stats="col.team.sides.dire" /></td></tr>
      <tr><th>Выбранная пятёрка · эта организация</th><td v-for="col in columns" :key="col.slot"><CompareStat :stats="col.team.selectedFiveOrganization" /></td></tr>
      <tr><th>Выбранная пятёрка · любые организации</th><td v-for="col in columns" :key="col.slot"><CompareStat :stats="col.team.cohesion.actual.exactFive" /></td></tr>
      <tr><th>Свежесть данных организации</th><td v-for="col in columns" :key="col.slot">{{dateLabel(col.team.organization.dataUpdatedAt)}}</td></tr>
    </tbody></table></div>
    <div class="compare-columns"><article v-for="col in columns" :key="col.slot"><h3>{{col.slot}} · Сила соперников и состав</h3>
      <p v-if="col.team.strength.status==='unavailable'" class="warning">{{col.team.strength.message}}</p>
      <template v-else><p>Средний Elo соперников перед картой: {{number(col.team.strength.summary.meanOpponentRatingBefore)}} · rated N = {{col.team.strength.summary.ratedMaps}}.</p>
        <p class="hint">Экспериментальный chronological Elo, не официальный ранг. Отдельная выборка последних 20 карт периода без patch/league-фильтра; глобальная ранняя история сохранена. Соперников с предыдущей историей: {{col.team.strength.coverage.opponentPriorMaps}}.</p></template>
      <p>Личности выбранной пятёрки: {{col.team.cohesion.actual.fingerprint?'все пять подтверждены по имеющимся данным':'подтверждены не полностью'}}. За последние 90 дней в пределах фильтров: N = {{col.team.cohesion.actual.exactFive.recentMaps??'неизвестно'}}.</p>
      <p>Смена состава в последних {{col.team.cohesion.churn.maps}} картах: {{col.team.cohesion.churn.changedTransitions??'неизвестно'}} переходов; известных {{col.team.cohesion.churn.knownTransitions}}.</p>
      <details><summary>{{col.slot}} · 10 пар и личная история</summary><div class="table-scroll"><table class="roster-table"><thead><tr><th>Пара игроков</th><th>N / победы · любые организации</th></tr></thead><tbody><tr v-for="(pair,i) in col.team.cohesion.actual.pairs" :key="i"><td>{{pair.playerIds.map(p=>p??'неизвестен').join(' + ')}}</td><td>{{pair.nRaw??'неизвестно'}} / {{pair.wins??'неизвестно'}}</td></tr></tbody></table></div>
        <p v-for="p in col.team.cohesion.actual.players" :key="p.rolePos">{{p.playerId??'неизвестен'}} · выбранная роль {{p.rolePos}} · pro N {{p.nRaw??'неизвестно'}} · роль подтверждена {{p.confirmedRoleMaps??'неизвестно'}} / совпадает {{p.selectedRoleMaps??'неизвестно'}} <span v-if="p.isStandin">· Stand-in</span></p></details>
      <details><summary>{{col.slot}} · Соперники за период</summary><p v-for="op in col.team.opponents" :key="op.opponentId??'unknown'">ID {{op.opponentId??'неизвестен'}}<CompareStat :stats="op.stats" /></p></details>
    </article></div>
    <h3>Личные встречи</h3><div class="summary-grid" role="group" aria-label="H2H двух организаций"><p><span>Эти организации · победы A</span><CompareStat :stats="report.h2h.organizations" /></p><p><span>Обе выбранные пятёрки · победы A</span><CompareStat :stats="report.h2h.selectedFives" /></p></div>
    <p class="hint">Только реальные карты между этими ID; одна карта учитывается один раз. Показано до100 строк, итоговые N включают всё окно. Неполных исторических пар пятёрок: {{report.coverage.h2hIncompleteFives}}. Скрыто строк: {{report.h2h.omittedMaps}}.</p>
    <p v-if="!report.h2h.organizations.nRaw">Нет наблюдаемых профессиональных личных встреч за этот период.</p>
    <div v-else class="table-scroll"><table aria-label="Карты H2H" class="compare-h2h"><thead><tr><th>Карта / UTC</th><th>A / B</th><th>Победитель</th><th>Фактическая пятёрка A</th><th>Фактическая пятёрка B</th><th>Обе выбранные пятёрки</th></tr></thead><tbody><tr v-for="m in report.h2h.maps" :key="m.matchId"><td>{{m.matchId}}<br />{{dateLabel(m.startedAt)}}</td><td>{{m.teamASide==='radiant'?'Radiant / Dire':'Dire / Radiant'}}</td><td>{{m.won?'A':'B'}}</td><td>{{m.teamAPlayerIds.map(p=>p??'неизвестен').join(', ')}}</td><td>{{m.teamBPlayerIds.map(p=>p??'неизвестен').join(', ')}}</td><td>{{m.matchesSelectedFives===null?'неизвестно':m.matchesSelectedFives?'совпадают':'отличаются'}}</td></tr></tbody></table></div>
    <details><summary>Покрытие и источники сравнения</summary><p>Кандидатов {{report.coverage.candidates}}; pro неизвестен {{report.coverage.unknownPro}}; непрофессиональных {{report.coverage.nonPro}}; конфликтных {{report.coverage.conflict}}; незавершённых {{report.coverage.unfinished}}; без одной из организаций {{report.coverage.unattributedOrganizationMaps}}.</p>
      <p>Текущая ретроспективная evidence не доказывает историческую известность состава. Неполные identities/патчи/серии раскрыты в provenance; unknown не равен0.</p>
      <p v-for="m in report.h2h.maps" :key="m.matchId">{{m.matchId}} · {{m.source}} · ревизия {{m.dataRevision}} · sync {{dateLabel(m.syncedAt)}} · fetch {{dateLabel(m.sourceFetchedAt)}}</p></details>
  </section>
</template>
