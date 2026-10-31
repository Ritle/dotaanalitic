<script setup lang="ts">
import {computed,reactive,ref,watch} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {HeroMatchupQuerySchema,HeroMatchupResponseSchema,type HeroMatchupQuery,type ScenarioSnapshot} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
import HeroPairValue from './HeroPairValue.vue';
const props=defineProps<{scenario:ScenarioSnapshot}>();
const filters=reactive({from:'',patchScope:'all',patchId:'',leagueId:'',weighted:false,version:'',halfLifeDays:'',minorPenalty:'',moderatePenalty:'',majorPenalty:'',minorFactor:'',moderateFactor:'',majorFactor:'',reworkFactor:''});
const applied=ref<HeroMatchupQuery|null>(null),error=ref('');
watch(filters,()=>{applied.value=null;error.value='';});
const request=useQuery({queryKey:computed(()=>['hero-matchups',props.scenario.id,props.scenario.revision,applied.value]),enabled:computed(()=>applied.value!==null),retry:false,
  queryFn:({signal})=>readCatalog(`scenarios/${props.scenario.id}/hero-matchups`,HeroMatchupResponseSchema,signal,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify(applied.value)})});
const report=computed(()=>applied.value&&request.data.value&&request.data.value.status!=='unavailable'?request.data.value:null);
const number=(s:string|number)=>String(s).trim()===''?NaN:Number(s);
function run(){
  const from=filters.from?new Date(filters.from+'Z'):null;
  if(from&&!Number.isFinite(from.getTime())){error.value='Проверьте начало периода UTC.';return;}
  const result=HeroMatchupQuerySchema.safeParse({expectedRevision:props.scenario.revision,fromAt:from?.toISOString(),patchScope:filters.patchScope,
    patchId:filters.patchScope==='specific'?filters.patchId:undefined,leagueId:filters.leagueId||undefined,
    weights:filters.weighted?{version:filters.version,validation:'unvalidated_candidate',draft:{halfLifeDays:number(filters.halfLifeDays),
      transitionPenalties:{minor:number(filters.minorPenalty),moderate:number(filters.moderatePenalty),major:number(filters.majorPenalty)},
      heroFactors:{unchanged:1,minor:number(filters.minorFactor),moderate:number(filters.moderateFactor),major:number(filters.majorFactor),rework:number(filters.reworkFactor)}}}:undefined});
  if(!result.success){error.value='Проверьте фильтры и заполните все коэффициенты эксперимента. Полупериод > 0, штрафы ≥ 0, факторы от 0 до 1.';return;}
  error.value='';if(JSON.stringify(applied.value)===JSON.stringify(result.data))void request.refetch();else applied.value=result.data;
}
const coefficientFields=[['minorPenalty','Штраф minor'],['moderatePenalty','Штраф moderate'],['majorPenalty','Штраф major'],['minorFactor','Фактор minor'],['moderateFactor','Фактор moderate'],['majorFactor','Фактор major'],['reworkFactor','Фактор rework']] as const;
</script>
<template>
  <section class="panel hero-matchups" aria-label="Пары героев"><h2>Пары героев</h2>
    <p>Союзные пары и направленные контрматчапы выбранного драфта · редакция {{scenario.revision}}. Статистика всех профессиональных карт с этими героями; она не описывает силу выбранных игроков или команд.</p>
    <p class="warning">Прогноз недоступен. Наблюдаемый WR, сглаживание и экспериментальные веса не являются вероятностью победы сценария.</p>
    <form @submit.prevent="run"><div class="pair-filters">
      <label>Пары: начало периода UTC<input v-model="filters.from" type="datetime-local" step="1" /><small>По умолчанию 90 дней до среза.</small></label>
      <label>Пары: патч<select v-model="filters.patchScope"><option value="all">Все патчи</option><option value="current">На дату среза</option><option value="specific">Конкретный патч</option></select></label>
      <label v-if="filters.patchScope==='specific'">Пары: ID патча<input v-model="filters.patchId" inputmode="numeric" /></label>
      <label>Пары: ID исторической лиги<input v-model="filters.leagueId" inputmode="numeric" placeholder="Все лиги" /></label>
    </div>
    <label class="weight-toggle"><input v-model="filters.weighted" type="checkbox" /> Эксперимент с весами</label>
    <fieldset v-if="filters.weighted"><legend>Непроверенная политика весов</legend><p class="warning">Политика не проверена на исторических данных. Значения задаёте вы; рекомендуемых коэффициентов пока нет. При нехватке сведений о патчах и героях оценка недоступна.</p>
      <div class="pair-filters"><label>Название политики<input v-model="filters.version" /></label><label>Полупериод, дней<input v-model="filters.halfLifeDays" type="number" step="any" min="0" /></label>
        <label v-for="[key,label] in coefficientFields" :key="key">{{label}}<input v-model="filters[key]" type="number" step="any" min="0" :max="key.endsWith('Factor')?1:undefined" /></label>
      </div><p class="hint">Для неизменившегося героя фактор равен 1. Целевая лига берётся из сохранённого сценария.</p>
    </fieldset>
    <button :disabled="request.isFetching.value" type="submit">{{request.isFetching.value?'Расчёт пар…':'Рассчитать пары'}}</button></form>
    <p v-if="error" role="alert" class="error">{{error}}</p><p v-if="applied&&request.error.value" role="alert" class="error">{{request.error.value.message}}</p>
    <p v-if="applied&&request.data.value?.status==='unavailable'" role="status" class="warning">{{request.data.value.message}}</p>
    <div v-if="report" data-testid="pair-report">
      <p v-if="report.status==='insufficient_data'" class="warning">В выборке нет подходящих пар. N=0; наблюдаемый WR неизвестен.</p>
      <p>Период: {{dateLabel(report.fromAt)}} ≤ начало карты &lt; {{dateLabel(report.cutoffAt)}}. Патч: {{report.effectivePatchId??'все, включая неизвестные'}}; историческая лига: {{report.query.leagueId??'все'}}.</p>
      <p class="hint">Данные обновлены: {{dateLabel(report.dataUpdatedAt)}}. Отчёт: {{dateLabel(report.snapshotAt)}}. Использованы завершённые карты и сведения, доступные сейчас; историческая доступность до драфта не подтверждается.</p>
      <p>Карт с выбранными героями: {{report.coverage.candidates}}; прошли фильтры: {{report.coverage.eligibleMaps}}; неполные герои: {{report.coverage.partialHeroMaps}}; некорректные строки: {{report.coverage.invalidHeroRows}}.</p>
      <p class="warning">Неизвестный pro-статус: {{report.coverage.unknownPro}}; не pro: {{report.coverage.nonPro}}; конфликты: {{report.coverage.conflict}}; неизвестный патч до фильтра: {{report.coverage.unknownPatchMaps}}; неподтверждённая серия: {{report.coverage.unverifiedSeriesMaps}}; поздняя загрузка: {{report.coverage.lateFetchedMaps}}.</p>
      <p v-if="report.warnings.includes('FUTURE_CUTOFF_CLAMPED')" class="warning">Будущий срез ограничен временем расчёта.</p>
      <p v-if="report.reference.status==='unavailable'" class="warning">Раннее окно превышает лимит: сглаживание недоступно, наблюдаемые показатели сохранены.</p>
      <p class="hint">Сглаживание использует только более ранние карты той же пары и патча с подтверждёнными сериями вне целевого окна. Размер опорной выборки показан отдельно.</p>
      <div v-for="slot in (['A','B'] as const)" :key="slot"><h3>Союзные пары {{slot}}</h3>
        <p v-if="!report.allies.some(p=>p.teamSlot===slot)">Назначьте хотя бы двух героев этой стороны.</p>
        <div v-else class="table-scroll" tabindex="0" :aria-label="`Таблица союзных пар ${slot}`"><table><thead><tr><th>Пара</th><th>Наблюдения и оценки</th></tr></thead><tbody>
          <tr v-for="p in report.allies.filter(p=>p.teamSlot===slot)" :key="p.heroA.heroId+'-'+p.heroB.heroId"><th scope="row">{{p.heroA.name}} + {{p.heroB.name}}</th><td><HeroPairValue :pair="p" /></td></tr>
        </tbody></table></div>
      </div>
      <h3>Контрматчапы A → B</h3><p>Строка A против столбца B. WR — доля побед стороны героя строки на реальных картах; A и B не означают Radiant и Dire.</p>
      <p v-if="!report.enemies.length">Нужен хотя бы один герой с каждой стороны.</p>
      <div v-else class="table-scroll" tabindex="0" aria-label="Матрица контрматчапов"><table><thead><tr><th scope="col">A / B</th><th v-for="h in report.heroes.filter(h=>h.teamSlot==='B')" :key="h.heroId" scope="col">{{h.name}}</th></tr></thead>
        <tbody><tr v-for="h in report.heroes.filter(h=>h.teamSlot==='A')" :key="h.heroId"><th scope="row">{{h.name}}</th><td v-for="p in report.enemies.filter(p=>p.heroA.heroId===h.heroId)" :key="p.heroB.heroId"><HeroPairValue :pair="p" /></td></tr></tbody>
      </table></div>
      <details><summary>Источники и параметры расчёта</summary><p>Источники: {{[...new Set(report.provenance.map(m=>m.source))].join(', ')||'нет карт'}}. Политика: {{report.policyVersion}}; реестр: {{report.registryRevision}}.</p><p class="pair-hash">Fingerprint: {{report.fingerprint}}</p><pre>{{JSON.stringify({query:report.query,reference:report.reference,provenance:report.provenance,weighted:report.query.weights?[...report.allies,...report.enemies].map(p=>({heroA:p.heroA.heroId,heroB:p.heroB.heroId,...p.weighted})):undefined},null,2)}}</pre></details>
    </div>
  </section>
</template>
<style scoped>.hero-matchups{min-width:0}.pair-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr));gap:16px;margin-block:16px}.pair-filters label{display:grid;gap:6px;min-width:0}.pair-filters input,.pair-filters select{width:100%;min-width:0;box-sizing:border-box}.weight-toggle{display:flex;align-items:center;gap:10px;margin-block:16px}.weight-toggle input{width:auto}fieldset{min-width:0;margin-block:16px}th,td{vertical-align:top;text-align:left;padding:12px}th{min-width:140px;max-width:220px;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}tr{border-bottom:1px solid var(--color-border)}summary{cursor:pointer;min-height:44px;padding-block:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;font-size:12px}.pair-hash{overflow-wrap:anywhere}</style>
