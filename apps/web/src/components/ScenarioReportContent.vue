<script setup lang="ts">
import type {ScenarioReport} from '@dota/contracts';
import {dateLabel} from '../catalog';
import CompareStat from './CompareStat.vue';
import HeroPairValue from './HeroPairValue.vue';
const props=defineProps<{snapshot:ScenarioReport}>();
const rate=(n:number|null)=>n===null?'нет данных':`${(n*100).toFixed(1)}%`;
const metric=(value:number|null)=>value===null?'нет данных':value.toFixed(1);
const age=(value:string)=>{const hours=(Date.parse(props.snapshot.report.snapshotAt)-Date.parse(value))/3600000;return hours>=0?`${Math.floor(hours)} ч на момент расчёта`:'дата синхронизации позже расчёта';};
</script>
<template>
  <article class="panel report-content" aria-label="Сохранённый отчёт">
    <h2>Отчёт · версия {{snapshot.version}}</h2><p>{{snapshot.report.scenario.input.title}} · редакция сценария {{snapshot.report.scenario.revision}}. Сохранён {{dateLabel(snapshot.createdAt)}}.</p>
    <p>Период: {{dateLabel(snapshot.report.fromAt)}} ≤ начало карты &lt; {{dateLabel(snapshot.report.cutoffAt)}}. Патч: {{snapshot.report.effectivePatchId??'все, включая неизвестные'}}. Историческая лига: {{snapshot.report.query.leagueId??'все'}}.</p>
    <p class="warning">Прогноз недоступен. Показатели описывают прошлые профессиональные карты; это не вероятность победы сценария.</p>
    <p v-if="snapshot.report.warnings.includes('FUTURE_CUTOFF_CLAMPED')" class="warning">Будущий срез ограничен временем расчёта: {{dateLabel(snapshot.report.snapshotAt)}}.</p>
    <section aria-label="Контекст и качество состава"><h3>Контекст и состав</h3>
      <p>A / B → Radiant / Dire: {{snapshot.report.scenario.input.context.radiantSlot===null?'неизвестно':snapshot.report.scenario.input.context.radiantSlot==='A'?'A / B':'B / A'}}. Первый пик: {{snapshot.report.scenario.input.context.firstPickSlot??'неизвестно'}}. Начало карты: {{dateLabel(snapshot.report.scenario.input.scheduledAt)}}.</p>
      <p class="warning">Состав вручную подтверждён владельцем {{dateLabel(snapshot.report.lineupEvidence.recordedAt)}}. Его историческая доступность до карты не доказана. Доступность драфта при сохранении: {{snapshot.report.scenario.draftAssessment?.status==='available'?'подтверждена для указанных героев':snapshot.report.scenario.draftAssessment?.status==='blocked'?'есть запрет':'не установлена полностью'}}.</p>
      <p>Роли ниже заданы вручную. В личной статистике учитываются только исторические карты с подтверждённой совпадающей ролью; при известной стороне сценария применяется и фильтр стороны.</p>
    </section>
    <section aria-label="Покрытие данных отчёта"><h3>Покрытие данных</h3>
      <p>Кандидатов: {{snapshot.report.coverage.candidates}}. Завершённых pro-карт после фильтров: {{snapshot.report.coverage.eligibleProMaps}}. Неизвестный патч до фильтра: {{snapshot.report.coverage.unknownPatchMaps}}. Неподтверждённая серия: {{snapshot.report.coverage.unknownSeriesMaps}}. Неполные герои: {{snapshot.report.coverage.partialHeroMaps}}.</p>
      <p>Неизвестное время загрузки: {{snapshot.report.coverage.sourceFetchUnknown}}. Загружены после среза: {{snapshot.report.coverage.lateFetchedMaps}}. Отчёт использует сведения на {{dateLabel(snapshot.report.snapshotAt)}}.</p>
      <p v-if="snapshot.report.provenance.referenceStatus==='unavailable'" class="warning">Ранняя опорная история превышает лимит. Сглаживание недоступно; наблюдаемые показатели сохранены.</p>
      <p v-if="snapshot.report.status==='insufficient_data'" class="warning">Истории выбранных организаций за период недостаточно. Проверьте отдельные выборки игроков и героев ниже.</p>
    </section>
    <section aria-label="Команды и составы"><h3>Организации и выбранные пятёрки</h3><div class="report-teams">
      <div v-for="[slot,team] in ([['A',snapshot.report.comparison.teamA],['B',snapshot.report.comparison.teamB]] as const)" :key="slot">
        <h4>{{slot}} · {{team.name}}</h4><p>Организация · наблюдаемый WR<CompareStat :stats="team.organization" /></p>
        <p>Выбранная пятёрка · любые организации<CompareStat :stats="team.cohesion.actual.exactFive" /></p>
        <p>Пятёрка в этой организации<CompareStat :stats="team.selectedFiveOrganization" /></p>
        <p>Исторический Radiant<CompareStat :stats="team.sides.radiant" /></p><p>Исторический Dire<CompareStat :stats="team.sides.dire" /></p>
        <p>Личности пятёрки: {{team.cohesion.actual.fingerprint?'пять подтверждённых':'подтверждены не полностью'}}. Обновление данных: {{dateLabel(team.organization.dataUpdatedAt)}}.</p>
        <p v-if="!team.cohesion.expected">Базовая ожидаемая пятёрка не задана. Изменение состава не оценивается.</p>
        <template v-else><p>Ожидаемая базовая пятёрка<CompareStat :stats="team.cohesion.expected.exactFive" /></p><p>Изменено игроков: {{team.cohesion.comparison?.changedPlayers}}; изменено ролей: {{team.cohesion.comparison?.roleChanges}}. Фиксированного штрафа за замену нет.</p></template>
        <details><summary>{{slot}} · Историческая сыгранность игроков</summary><p v-for="(pair,i) in team.cohesion.actual.pairs" :key="i">{{pair.playerIds.join(' + ')}}<CompareStat :stats="pair" /></p></details>
      </div>
    </div><p>Личные встречи организаций · победы A<CompareStat :stats="snapshot.report.comparison.h2h.organizations" /></p></section>
    <section aria-label="Игроки и герои по ролям"><h3>Игроки и герои по ролям</h3>
      <p class="hint">На узком экране прокрутите таблицу вправо, чтобы увидеть показатели и качество выборки.</p>
      <div class="table-scroll" tabindex="0" aria-label="Таблица игроков по ролям"><table><thead><tr><th>Команда / роль / игрок</th><th>Герой / сторона</th><th>Наблюдаемый WR</th><th>KDA / GPM / XPM</th><th>Данные и качество</th></tr></thead><tbody>
        <tr v-for="p in snapshot.report.players" :key="p.teamSlot+p.rolePos"><th scope="row">{{p.teamSlot}} · роль {{p.rolePos}}<br />{{p.playerId}}</th><td>{{p.heroName??(p.heroId===null?'Не назначен · все герои':`#${p.heroId}`)}}<br />{{p.report.filters.side??'сторона не задана'}}</td>
          <template v-if="p.report.status!=='unavailable'"><td>N={{p.report.summary.nRaw}} · {{rate(p.report.summary.winRate)}}<br /><span v-if="p.report.summary.sampleEvidence.smallSample" class="warning">Малая выборка</span><br />{{p.report.summary.wins}} побед</td>
            <td>KDA {{metric(p.report.summary.kda.value)}} · N={{p.report.summary.kda.nMaps}}<br />GPM {{metric(p.report.summary.meanGpm.value)}} · N={{p.report.summary.meanGpm.nMaps}}<br />XPM {{metric(p.report.summary.meanXpm.value)}} · N={{p.report.summary.meanXpm.nMaps}}</td>
            <td>Последняя карта: {{dateLabel(p.report.summary.lastPlayedAt)}}<br />Обновлено: {{dateLabel(p.report.summary.dataUpdatedAt)}}<br />Личность не установлена в {{p.report.coverage.identityUnresolved}} картах; патч известен {{p.report.coverage.knownPatch}} / {{p.report.summary.nRaw}}.</td>
          </template><td v-else colspan="3" class="warning">{{p.report.message}}</td>
        </tr></tbody></table></div>
    </section>
    <section aria-label="Meta назначенных героев"><h3>Meta назначенных героев</h3><p>Наблюдаемая статистика всех завершённых pro-карт корпуса с выбранными фильтрами. Для WR достаточно достоверного героя на карте; частота пика считается только среди полных драфтов. История банов не оценивается.</p>
      <p v-if="!snapshot.report.heroMeta.length">Герои не назначены.</p><div v-else class="table-scroll" tabindex="0" aria-label="Таблица meta героев"><table><thead><tr><th>Герой</th><th>Наблюдаемый WR</th><th>Частота пика</th><th>Патчи / обновление</th></tr></thead><tbody><tr v-for="h in snapshot.report.heroMeta" :key="h.heroId"><th>{{h.name}}</th><td>N={{h.nRaw}} · {{h.wins}} побед · {{rate(h.winRate)}}</td><td>{{rate(h.pickRate)}}<br />{{h.knownDraftPicks}} / {{h.completeDraftMaps}} полных драфтов</td><td>{{h.patchDistribution.map(p=>`${p.patchId??'неизвестен'}: ${p.nRaw}`).join(', ')||'нет карт'}}<br />{{dateLabel(h.dataUpdatedAt)}}</td></tr></tbody></table></div>
    </section>
    <section aria-label="Скорректированные показатели"><h3>Скорректированные показатели</h3>
      <p>Сглаженные оценки и веса показаны отдельно от наблюдаемого WR. Они экспериментальные и не прошли проверку как вероятности сценария.</p>
      <p v-if="!snapshot.report.query.weights">Политика весов не задана: взвешенные оценки и N_eff недоступны.</p>
      <p v-else class="warning">Политика весов: {{snapshot.report.query.weights.version}}. Коэффициенты заданы вручную и не проверены на исторической валидации.</p>
      <p v-for="p in snapshot.report.players" :key="p.teamSlot+p.rolePos">{{p.teamSlot}} · роль {{p.rolePos}}: сглаженный WR {{p.report.status==='unavailable'?'нет данных':rate(p.report.smoothing.smoothedObservedRate)}}<span v-if="p.report.status!=='unavailable'">; ранняя опорная выборка N={{p.report.smoothing.prior?.mass??'неизвестно'}}</span>.</p>
      <div v-for="[slot,team] in ([['A',snapshot.report.comparison.teamA],['B',snapshot.report.comparison.teamB]] as const)" :key="slot"><p v-if="team.strength.status==='unavailable'">{{slot}} · аудит силы соперников недоступен: {{team.strength.message}}</p><p v-else>{{slot}} · экспериментальный аудит Elo: средний предматчевый рейтинг соперника {{metric(team.strength.summary.meanOpponentRatingBefore)}}; N={{team.strength.summary.ratedMaps}}. Отдельная выборка: последние20 карт в периоде, без фильтра патча/лиги; глобальная ранняя история сохранена.</p></div>
    </section>
    <section aria-label="Пары и контрматчапы отчёта"><h3>Пары и контрматчапы героев</h3>
      <p>Общая история героев на pro-картах. Она не ограничена выбранными игроками. Победа следует реальной стороне героя, A/B сценария не задают Radiant/Dire для этих наблюдений.</p>
      <p v-if="snapshot.report.pairs.status==='unavailable'" class="warning">{{snapshot.report.pairs.message}}</p>
      <template v-else><div v-for="slot in (['A','B'] as const)" :key="slot"><h4>Союзные пары {{slot}}</h4><p v-if="!snapshot.report.pairs.allies.some(p=>p.teamSlot===slot)">Недостаточно назначенных героев.</p><div v-else class="table-scroll" tabindex="0" :aria-label="`Пары отчёта ${slot}`"><table><thead><tr><th>Пара</th><th>Наблюдения / оценки</th></tr></thead><tbody><tr v-for="p in snapshot.report.pairs.allies.filter(p=>p.teamSlot===slot)" :key="p.heroA.heroId+'-'+p.heroB.heroId"><th>{{p.heroA.name}} + {{p.heroB.name}}</th><td><HeroPairValue :pair="p" /></td></tr></tbody></table></div></div>
        <h4>Контрматчапы A → B</h4><p v-if="!snapshot.report.pairs.enemies.length">Нужен герой с каждой стороны.</p><div v-else class="table-scroll" tabindex="0" aria-label="Матрица сохранённого отчёта"><table><thead><tr><th>A / B</th><th v-for="h in snapshot.report.pairs.heroes.filter(h=>h.teamSlot==='B')" :key="h.heroId">{{h.name}}</th></tr></thead><tbody><tr v-for="h in snapshot.report.pairs.heroes.filter(h=>h.teamSlot==='A')" :key="h.heroId"><th>{{h.name}}</th><td v-for="p in snapshot.report.pairs.enemies.filter(p=>p.heroA.heroId===h.heroId)" :key="p.heroB.heroId"><HeroPairValue :pair="p" /></td></tr></tbody></table></div>
      </template>
    </section>
    <details><summary>Исходные pro-карты корпуса</summary><p>Показаны до100 карт, прошедших фильтры. Всего {{snapshot.report.coverage.eligibleProMaps}}; полный список ID и источников сохранён в снимке ниже. Ссылки ведут на сайт источника.</p><p v-for="m in snapshot.report.provenance.maps.filter(m=>m.included).slice(0,100)" :key="m.matchId"><a v-if="m.source==='opendota'" :href="`https://www.opendota.com/matches/${m.matchId}`" target="_blank" rel="noopener noreferrer">Карта {{m.matchId}} · OpenDota</a><span v-else>Карта {{m.matchId}} · {{m.source}}</span><br />Начало {{dateLabel(m.startedAt)}}; синхронизация {{dateLabel(m.syncedAt)}} · {{age(m.syncedAt)}}; получение источника {{dateLabel(m.sourceFetchedAt)}}.</p></details>
    <details><summary>Источники и полный сохранённый снимок</summary><p>Источник: нормализованные локальные карты; {{[...new Set(snapshot.report.provenance.maps.map(m=>m.source))].join(', ')||'карт нет'}}. Алгоритм {{snapshot.report.policyVersion}}. Identity revision {{snapshot.report.provenance.identityRevision}}, registry revision {{snapshot.report.provenance.registryRevision}}.</p><p class="report-hash">SHA-256: {{snapshot.resultHash}}</p><pre>{{JSON.stringify(snapshot.report,null,2)}}</pre></details>
  </article>
</template>
<style scoped>.report-content{min-width:0}.report-teams{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:24px}section{margin-block:24px}table{border-collapse:collapse;width:100%}th,td{padding:12px;min-width:145px;max-width:250px;vertical-align:top;text-align:left;overflow-wrap:anywhere}tr{border-bottom:1px solid var(--color-border)}summary{cursor:pointer;min-height:44px;padding-block:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto;font-size:12px}.report-hash{overflow-wrap:anywhere}</style>
