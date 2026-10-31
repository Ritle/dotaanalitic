<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {RosterRequestSchema,RosterResponseSchema,type RosterRequest} from '@dota/contracts';
import {ownerAuth} from '../auth';
import {readCatalog,dateLabel} from '../catalog';
import SampleNote from './SampleNote.vue';
const props=defineProps<{id:string}>();
const five=()=>Array.from({length:5},(_,i)=>({playerId:'',rolePos:i+1,isStandin:false}));
const lineup=ref(five()),expected=ref(five()),hasExpected=ref(false),fromAt=ref(''),cutoffAt=ref(''),validation=ref('');
const applied=ref<RosterRequest|null>(null);
watch([lineup,expected,hasExpected,fromAt,cutoffAt],()=>{applied.value=null;validation.value='';},{deep:true});
const {data,isFetching,isError,error,refetch}=useQuery({queryKey:computed(()=>['roster',props.id,applied.value]),
  enabled:computed(()=>!!ownerAuth.value&&applied.value!==null),queryFn:({signal})=>readCatalog(`teams/${props.id}/roster-cohesion`,RosterResponseSchema,signal,
    {method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value!.csrfToken},body:JSON.stringify(applied.value)})});
const report=computed(()=>applied.value&&data.value?.status!=='unavailable'?data.value:null);
const value=(n:number|null|undefined)=>n===null||n===undefined?'неизвестно':String(n);
const rate=(n:number|null)=>n===null?'неизвестно':new Intl.NumberFormat('ru-RU',{style:'percent',maximumFractionDigits:1}).format(n);
function submit(){
  const members=(rows:ReturnType<typeof five>)=>rows.map(p=>({...p,playerId:p.playerId.trim()||null}));
  const time=(s:string)=>s?new Date(s+'Z').toISOString():undefined;
  const parsed=RosterRequestSchema.safeParse({lineup:members(lineup.value),expectedLineup:hasExpected.value?members(expected.value):null,
    fromAt:time(fromAt.value),cutoffAt:time(cutoffAt.value)});
  if(!parsed.success){validation.value='Укажите пять разных ID из справочника. Пустой ID означает неизвестного игрока. Начало периода должно быть раньше среза.';return;}
  validation.value='';
  if(JSON.stringify(applied.value)===JSON.stringify(parsed.data)){void refetch();return;}
  applied.value=parsed.data;
}
</script>
<template>
  <section class="panel" aria-labelledby="roster-title">
    <p class="eyebrow">Состав и замены</p><h2 id="roster-title">История выбранной пятёрки</h2>
    <p>Задайте игроков и роли вручную. Это ваш вариант состава, а не подтверждение участия в предстоящем матче. Расчёт не сохраняет сценарий.</p>
    <form @submit.prevent="submit">
      <fieldset><legend>Выбранная пятёрка</legend>
        <div v-for="(member,i) in lineup" :key="i" class="roster-row">
          <label :for="`actual-player-${i}`">Роль {{member.rolePos}} · ID игрока<input :id="`actual-player-${i}`" v-model="member.playerId" inputmode="numeric" :aria-label="`Выбранный игрок роли ${member.rolePos}`" placeholder="Неизвестен" /></label>
          <label class="check-label"><input v-model="member.isStandin" type="checkbox" :aria-label="`Stand-in роли ${member.rolePos}`" /> Stand-in</label>
        </div>
      </fieldset>
      <label class="check-label"><input v-model="hasExpected" type="checkbox" /> Сравнить с базовой пятёркой</label>
      <fieldset v-if="hasExpected"><legend>Базовая пятёрка</legend><div v-for="(member,i) in expected" :key="i">
        <label :for="`expected-player-${i}`">Роль {{member.rolePos}} · ID игрока<input :id="`expected-player-${i}`" v-model="member.playerId" inputmode="numeric" :aria-label="`Базовый игрок роли ${member.rolePos}`" placeholder="Неизвестен" /></label>
      </div></fieldset>
      <div class="map-filters roster-dates"><label>Начало истории, UTC<input v-model="fromAt" type="datetime-local" /></label>
        <label>Срез истории, UTC<input v-model="cutoffAt" type="datetime-local" /></label></div>
      <p class="hint">Пустые даты: вся доступная локальная история до запроса. Свежесть — последние 90 дней до среза; смены состава — последние 20 завершённых pro-карт организации. ID можно найти в справочнике игроков.</p>
      <p v-if="validation" role="alert" class="error">{{validation}}</p>
      <button type="submit" :disabled="isFetching">{{isFetching?'Расчёт…':'Рассчитать сыгранность'}}</button>
    </form>
    <p v-if="applied&&isFetching" role="status">Читаем историю профессиональных карт…</p>
    <div v-if="applied&&isError" role="alert"><p class="error">{{error?.message}}</p><button type="button" @click="refetch()">Повторить расчёт</button></div>
    <p v-if="applied&&data?.status==='unavailable'" role="status" class="warning">{{data.message}}</p>
    <template v-if="report">
      <h3>Результат расчёта</h3>
      <p v-if="report.status==='partial'" class="warning">Часть личностей или исторических составов неизвестна. Подсчёт сыгранности неполный; проверьте покрытие ниже.</p>
      <p class="warning">Наблюдаемая история, без прогноза силы или штрафа за замену. Поздно полученные данные не доказывают предматчевую известность состава. Полнота всей pro-истории не гарантирована.</p>
      <dl class="metadata"><dt>Период</dt><dd>{{report.input.fromAt?dateLabel(report.input.fromAt):'Вся локальная история'}} → {{dateLabel(report.cutoffAt)}} (начало карты строго раньше)</dd>
        <dt>Источник / расчёт</dt><dd>Локальные pro-карты · {{dateLabel(report.snapshotAt)}}</dd>
        <dt>Ревизии</dt><dd>Личности {{report.identityRevision}} · патчи {{report.registryRevision}} · {{report.policyVersion}}</dd>
        <dt>Обновление истории пятёрки</dt><dd>{{dateLabel(report.actual.exactFive.dataUpdatedAt)}}</dd></dl>
      <div class="summary-grid" role="group" aria-label="Сыгранность выбранной пятёрки">
        <p><strong>{{value(report.actual.exactFive.nRaw)}}</strong><span>Карт точной пятёркой · любые организации</span></p>
        <p><strong>{{value(report.actual.exactFive.recentMaps)}}</strong><span>Из них за 90 дней</span></p>
        <p><strong>{{value(report.actual.exactFiveOrganizationMaps)}}</strong><span>В этой организации</span></p>
        <p><strong>{{rate(report.actual.exactFive.winRate)}}</strong><span>Наблюдаемая частота побед · не прогноз</span></p>
      </div>
      <SampleNote :evidence="report.actual.exactFive.sampleEvidence" />
      <p>Первая совместная карта: {{dateLabel(report.actual.exactFive.firstAt)}}. Последняя: {{dateLabel(report.actual.exactFive.lastAt)}}.</p>
      <p v-if="report.comparison" role="group" aria-label="Сравнение составов">{{report.comparison.changedPlayers?'Замена':'Состав сохранён'}}:
        сохранено {{report.comparison.retainedPlayers}} из 5 игроков и {{report.comparison.retainedPairLinks}} из 10 пар;
        новых пар {{report.comparison.addedPairLinks}}, потерянных {{report.comparison.lostPairLinks}}. Перестановок ролей: {{report.comparison.roleChanges}}.
        Базовая пятёрка: N = {{value(report.expected?.exactFive.nRaw)}}, за 90 дней {{value(report.expected?.exactFive.recentMaps)}}.</p>
      <p v-else class="warning">Статус замены неизвестен: базовая или выбранная пятёрка неполна.</p>
      <h3>10 исторических пар</h3><p class="hint">Каждая пара считает карту один раз на одной стороне, включая прошлые организации. Сумма десяти N не является числом карт команды. Неполные исторические пятёрки исключены из co-play.</p>
      <div class="table-scroll"><table aria-label="Исторические пары" class="roster-table"><thead><tr><th>Игроки</th><th>N / победы</th><th>За 90 дней / здесь</th><th>Последняя карта</th><th>Патчи (N)</th></tr></thead><tbody>
        <tr v-for="(pair,i) in report.actual.pairs" :key="i"><td>{{pair.playerIds.map(id=>id??'неизвестен').join(' + ')}}</td><td>{{value(pair.nRaw)}} / {{value(pair.wins)}}</td>
          <td>{{value(pair.recentMaps)}} / {{value(pair.organizationMaps)}}</td><td>{{dateLabel(pair.lastAt)}}</td><td>{{pair.patchDistribution.map(p=>`${p.patchId??'неизвестен'}: ${p.maps}`).join(', ')||'нет наблюдений'}}</td></tr>
      </tbody></table></div>
      <details v-if="report.expected"><summary>Исторические пары базовой пятёрки</summary><div class="table-scroll"><table aria-label="Базовые исторические пары"><thead><tr><th>Игроки</th><th>N</th><th>Последняя карта</th></tr></thead><tbody><tr v-for="(pair,i) in report.expected.pairs" :key="i"><td>{{pair.playerIds.join(' + ')}}</td><td>{{value(pair.nRaw)}}</td><td>{{dateLabel(pair.lastAt)}}</td></tr></tbody></table></div></details>
      <h3>Личная история и роли</h3><div class="table-scroll"><table aria-label="Личная история выбранных игроков" class="roster-table"><thead><tr><th>Игрок / выбранная роль</th><th>N / победы</th><th>Роль подтверждена / совпадает</th><th>История организаций</th></tr></thead><tbody>
        <tr v-for="p in report.actual.players" :key="p.rolePos"><td>{{p.playerId??'неизвестен'}} · роль {{p.rolePos}}<span v-if="p.isStandin"> · Stand-in</span><br />{{p.identityStatus==='verified'?'Личность подтверждена':'Личность не подтверждена'}}</td><td>{{value(p.nRaw)}} / {{value(p.wins)}}</td><td>{{value(p.confirmedRoleMaps)}} / {{value(p.selectedRoleMaps)}}</td>
          <td><div v-for="org in p.organizations" :key="org.organizationId??'unknown'">{{org.organizationId??'неизвестна'}}: N = {{value(org.nRaw)}} · {{dateLabel(org.firstAt)}} → {{dateLabel(org.lastAt)}}</div></td></tr>
      </tbody></table></div>
      <h3>Смены состава организации</h3><p>Последние карты: N = {{report.churn.maps}}, полные составы: {{report.churn.completeMaps}}. Уникальных пятёрок: {{value(report.churn.uniqueFives)}}. Переходов со сменой игроков: {{value(report.churn.changedTransitions)}}.</p>
      <p>Проверенных соседних переходов: {{report.churn.knownTransitions}} из {{report.churn.transitions.length}}. Пробелы не означают ноль замен.</p>
      <details><summary>Покрытие и источники</summary><p>Кандидатов {{report.coverage.candidates}}; завершённых pro-карт {{report.coverage.eligibleMaps}}; неполных сторон {{report.coverage.incompleteSides}}; конфликтов личностей на карте {{report.coverage.duplicateIdentityMaps}}.</p>
        <p>Pro неизвестен {{report.coverage.unknownPro}}; непрофессиональных {{report.coverage.nonPro}}; конфликтных {{report.coverage.conflict}}; незавершённых {{report.coverage.unfinished}}. Патч известен для {{report.coverage.knownPatchMaps}} карт.</p>
        <p>Источник получен после среза: {{report.coverage.lateFetchedMaps}}; дата получения неизвестна: {{report.coverage.sourceFetchUnknown}}.</p>
        <p class="warning" v-if="report.coverage.incompleteSides||report.actual.fingerprint===null">Часть истории или личностей неизвестна. Наблюдаемые N не показывают полную историю сыгранности.</p>
        <p v-for="m in report.provenance" :key="m.matchId">Карта {{m.matchId}} · {{m.source}} · ревизия {{m.dataRevision}} · синхронизация {{dateLabel(m.syncedAt)}} · получение {{dateLabel(m.sourceFetchedAt)}}</p>
      </details>
    </template>
  </section>
</template>
