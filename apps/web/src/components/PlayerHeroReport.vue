<script setup lang="ts">
import {computed,ref} from 'vue';
import {useQuery} from '@tanstack/vue-query';
import {PlayerHeroResponseSchema} from '@dota/contracts';
import {readCatalog,dateLabel} from '../catalog';
import {ownerAuth} from '../auth';
const props=defineProps<{id:string}>();
const from=ref(''),cutoff=ref(''),patchScope=ref('current'),patch=ref(''),hero=ref(''),role=ref(''),side=ref('');
const applied=ref('patchScope=current');
const {data,isPending,isFetching,isError,error,refetch}=useQuery({queryKey:computed(()=>['player-heroes',props.id,applied.value]),enabled:computed(()=>!!ownerAuth.value),
  queryFn:({signal})=>readCatalog(`players/${props.id}/heroes?${applied.value}`,PlayerHeroResponseSchema,signal)});
const report=computed(()=>data.value?.status!=='unavailable'?data.value:null);
const number=(n:number|null)=>n===null?'неизвестно':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(n);
const rate=(n:number|null)=>n===null?'неизвестно':new Intl.NumberFormat('ru-RU',{style:'percent',maximumFractionDigits:1}).format(n);
const metric=(m:{value:number|null;nMaps:number},total:number)=>`${number(m.value)} · N ${m.nMaps}/${total}`;
function apply(){
  const query=new URLSearchParams({patchScope:patchScope.value});
  if(from.value)query.set('fromAt',new Date(from.value+'Z').toISOString());
  if(cutoff.value)query.set('cutoffAt',new Date(cutoff.value+'Z').toISOString());
  for(const [key,value] of [['patchId',patchScope.value==='specific'?patch.value:''],['heroId',hero.value],['rolePos',role.value],['side',side.value]])
    if(value?.trim())query.set(key!,value.trim());
  const next=query.toString();if(next===applied.value)void refetch();else applied.value=next;
}
</script>
<template>
  <section class="panel" aria-labelledby="player-hero-title">
    <p class="eyebrow">Профессиональная история игрока</p><h2 id="player-hero-title">Герой и позиция</h2>
    <p class="hint">Сырые показатели завершённых pro-карт через любые организации. По умолчанию — подтверждённый патч на дату среза и 90 дней. У каждой метрики указан N доступных карт; пропуски остаются неизвестными.</p>
    <form class="map-filters" @submit.prevent="apply">
      <div><label for="ph-from">Герои: начало периода (UTC)</label><input id="ph-from" v-model="from" type="datetime-local" /></div>
      <div><label for="ph-cutoff">Герои: срез истории (UTC)</label><input id="ph-cutoff" v-model="cutoff" type="datetime-local" /></div>
      <div><label for="ph-scope">Патчи героя</label><select id="ph-scope" v-model="patchScope"><option value="current">Патч на дату среза</option><option value="all">Все патчи</option><option value="specific">Конкретный патч</option></select></div>
      <div v-if="patchScope==='specific'"><label for="ph-patch">Герои: ID проверенного патча</label><input id="ph-patch" v-model="patch" inputmode="numeric" maxlength="19" /></div>
      <div><label for="ph-hero">Герои: ID героя</label><input id="ph-hero" v-model="hero" inputmode="numeric" maxlength="19" placeholder="Все герои" /></div>
      <div><label for="ph-role">Герои: подтверждённая позиция</label><select id="ph-role" v-model="role"><option value="">Все, включая неизвестную</option><option v-for="n in 5" :key="n" :value="String(n)">Позиция {{n}}</option></select></div>
      <div><label for="ph-side">Герои: сторона</label><select id="ph-side" v-model="side"><option value="">Обе стороны</option><option value="radiant">Radiant</option><option value="dire">Dire</option></select></div>
      <button type="submit">Применить фильтры героев</button>
    </form>
    <p v-if="isPending" role="status">Загружаем историю героев…</p>
    <div v-else-if="isError" role="alert"><p class="error">{{error?.message}}</p><button type="button" @click="refetch()">Повторить расчёт героев</button></div>
    <p v-else-if="data?.status==='unavailable'" role="status" class="warning">{{data.message}}</p>
    <template v-else-if="report">
      <p class="hint">Применённый период UTC: {{dateLabel(report.fromAt)}} → {{dateLabel(report.cutoffAt)}}. Старт строго раньше среза; карта завершена.</p>
      <p class="hint">Применённые фильтры: {{report.filters.patchScope==='all'?'все патчи':`патч ID ${report.effectivePatchId}`}} · герой {{report.filters.heroId??'любой'}} · роль {{report.filters.rolePos??'все / неизвестная'}} · сторона {{report.filters.side??'обе'}}. Без ограничения last N и скрытых весов.</p>
      <div class="summary-grid" role="group" aria-label="Показатели игрока на героях">
        <p><strong>N = {{report.summary.nRaw}}</strong><span>Выбранных карт · побед {{report.summary.wins}}</span></p>
        <p><strong>{{rate(report.summary.winRate)}}</strong><span>Наблюдаемый win rate</span></p>
        <p><strong>{{number(report.summary.kda.value)}}</strong><span>KDA · N {{report.summary.kda.nMaps}}/{{report.summary.nRaw}}</span></p>
        <p><strong>{{rate(report.selectedHeroShare)}}</strong><span>Доля выбранных героев среди {{report.playerMapsInScope}} pro-карт тех же фильтров</span></p>
      </div>
      <p v-if="report.status==='insufficient_data'">Нет подтверждённых профессиональных игр на герое за выбранный период. При N = 0 показатели неизвестны.</p>
      <p class="hint">Средние K / D / A: {{metric(report.summary.meanKills,report.summary.nRaw)}} / {{metric(report.summary.meanDeaths,report.summary.nRaw)}} / {{metric(report.summary.meanAssists,report.summary.nRaw)}}.</p>
      <p class="hint">GPM: {{metric(report.summary.meanGpm,report.summary.nRaw)}}. XPM: {{metric(report.summary.meanXpm,report.summary.nRaw)}}.</p>
      <p class="hint">Последняя игра: {{dateLabel(report.summary.lastPlayedAt)}} · синхронизация: {{dateLabel(report.summary.dataUpdatedAt)}} · расчёт: {{dateLabel(report.snapshotAt)}} · источник: локальные карты.</p>
      <p class="warning">Позиция подтверждена в {{report.coverage.confirmedRole}}/{{report.summary.nRaw}} карт; герой известен в {{report.coverage.knownHero}}/{{report.summary.nRaw}}; патч в {{report.coverage.knownPatch}}/{{report.summary.nRaw}}. Это наблюдаемая история локальной БД; её полнота не гарантирована.</p>
      <p class="hint">KDA = (сумма K + сумма A) / max(1, сумма D) только по полным тройкам K/D/A. Средние K/D/A, GPM и XPM используют собственные доступные поля. Перестановки позиций сохраняются в отдельных строках; неподтверждённые роли не угадываются.</p>
      <div v-if="report.groups.length" class="table-scroll"><table class="player-hero-table"><caption class="sr-only">Игрок, герой и подтверждённая позиция</caption>
        <thead><tr><th scope="col">Герой / роль</th><th scope="col">N / победы / WR</th><th scope="col">Средние K / D / A (N)</th><th scope="col">KDA (N)</th><th scope="col">GPM / XPM (N)</th><th scope="col">Доля героя</th><th scope="col">Последняя карта</th></tr></thead>
        <tbody><tr v-for="g in report.groups" :key="`${g.heroId}:${g.rolePos}`"><td>{{g.heroName??(g.heroId?'Название неизвестно':'Герой неизвестен')}}<span class="catalog-id">ID {{g.heroId??'неизвестен'}} · роль {{g.rolePos??'не подтверждена'}}</span></td>
          <td>{{g.nRaw}} / {{g.wins}} / {{rate(g.winRate)}}</td><td>{{metric(g.meanKills,g.nRaw)}}<br />{{metric(g.meanDeaths,g.nRaw)}}<br />{{metric(g.meanAssists,g.nRaw)}}</td>
          <td>{{metric(g.kda,g.nRaw)}}</td><td>{{metric(g.meanGpm,g.nRaw)}}<br />{{metric(g.meanXpm,g.nRaw)}}</td><td>{{rate(g.heroPickRate)}}<span class="catalog-id">{{g.heroMaps}}/{{report.playerMapsInScope}} карт, все роли применённых фильтров</span></td><td>{{dateLabel(g.lastPlayedAt)}}</td></tr></tbody>
      </table></div>
      <details><summary>Покрытие и карты расчёта</summary>
        <p>Кандидатов {{report.coverage.candidates}}. Исключено: pro неизвестен {{report.coverage.unknownPro}}, не pro {{report.coverage.nonPro}}, конфликт {{report.coverage.conflict}}, незавершённые {{report.coverage.unfinished}}, игрок не подтверждён {{report.coverage.identityUnresolved}}, основные фильтры {{report.coverage.filterMismatch}}, другой герой {{report.coverage.heroFilterMismatch}}.</p>
        <p>Получено после среза: {{report.coverage.lateFetchedMaps}} карт; дата получения неизвестна: {{report.coverage.sourceFetchUnknown}}. Поздняя загрузка не подтверждает предматчевую доступность данных.</p>
        <p>Патчи (N): {{report.patchDistribution.map(p=>`${p.patchId??'неизвестен'}: ${p.maps}`).join(', ')||'нет карт'}}. Ревизии: личности {{report.identityRevision}}, registry {{report.registryRevision}}; {{report.policyVersion}}.</p>
        <p v-for="m in report.maps" :key="m.matchId">Карта {{m.matchId}} · {{dateLabel(m.startedAt)}} · {{m.side}} · {{m.won?'победа':'поражение'}} · {{m.source}} · ревизия {{m.dataRevision}} · синхронизация {{dateLabel(m.syncedAt)}}.</p>
      </details>
      <button type="button" :disabled="isFetching" @click="refetch()">{{isFetching?'Обновление…':'Перечитать героев'}}</button>
    </template>
  </section>
</template>
