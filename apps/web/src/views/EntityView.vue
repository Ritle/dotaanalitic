<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { TeamOverviewSchema, PlayerOverviewSchema, type TeamOverview, type PlayerOverview } from '@dota/contracts';
import { readCatalog, dateLabel } from '../catalog';
import { ownerAuth } from '../auth';
import ProMapReport from '../components/ProMapReport.vue';
import RosterReport from '../components/RosterReport.vue';
import PlayerHeroReport from '../components/PlayerHeroReport.vue';
import RankedPractice from '../components/RankedPractice.vue';
import StrengthReport from '../components/StrengthReport.vue';
import HistoryRefresh from '../components/HistoryRefresh.vue';
import CurrentRoster from '../components/CurrentRoster.vue';
import TeamActivity from '../components/TeamActivity.vue';
const route=useRoute();
const kind=computed(()=>route.name==='team'?'teams':'players');
const id=computed(()=>String(route.params.id));
const {data,isPending,isError,error,isFetching,refetch}=useQuery({
  queryKey:computed(()=>['catalog','overview',kind.value,id.value]),enabled:computed(()=>!!ownerAuth.value),
  queryFn:async({signal}):Promise<TeamOverview|PlayerOverview>=>kind.value==='teams'?readCatalog(`teams/${encodeURIComponent(id.value)}`,TeamOverviewSchema,signal)
    :readCatalog(`players/${encodeURIComponent(id.value)}`,PlayerOverviewSchema,signal)
});
</script>

<template>
  <section class="panel" :aria-label="kind==='teams'?'Карточка организации':'Карточка игрока'">
    <RouterLink to="/">← К справочникам</RouterLink>
    <p v-if="isPending" role="status">Загружаем обзор…</p>
    <div v-else-if="isError" role="alert"><p class="error">{{error?.message}}</p><button type="button" @click="refetch()">Повторить</button></div>
    <template v-else-if="data">
      <p class="eyebrow">{{data.entityType==='organization'?'Организация':'Игрок'}}</p>
      <h2>{{data.entity.name.trim()||(kind==='teams'?'Команда без названия':'Игрок без ника')}}</h2>
      <p v-if="kind==='teams'&&data.entity.secondary">Тег команды: {{data.entity.secondary}}</p>
      <details><summary>Данные записи</summary><p>Внутренний ID: {{data.entity.id}}</p></details>
      <dl class="metadata"><dt>Источник</dt><dd>Локальный справочник</dd><dt>Синхронизация</dt><dd>{{dateLabel(data.entity.syncedAt)}}</dd>
        <dt>Изменение записи</dt><dd>{{dateLabel(data.entity.metadataUpdatedAt)}}</dd><dt>Прочитано</dt><dd>{{dateLabel(data.computedAt)}}</dd></dl>
      <TeamActivity v-if="kind==='teams'" :key="id" :id="id" />
      <CurrentRoster :key="kind+id" :kind="kind" :id="id" />
      <template v-if="data.entityType==='organization'">
        <HistoryRefresh :team-id="id" />
        <RouterLink :to="{path:'/compare',query:{teamA:id}}">Сравнить эту организацию с другой →</RouterLink>
        <p class="hint">Сведения реестра о составе показаны выше. Ниже — участники последней завершённой карты в локальной базе.</p>
        <h3>Последний наблюдавшийся состав</h3>
        <p class="hint">Это участники завершённой pro-карты, а не текущий состав. Подсказки ролей в реестре выше не определяют роли в этой карте.</p>
        <template v-if="data.latestObservedLineup">
          <p>Карта {{data.latestObservedLineup.matchId}} · {{dateLabel(data.latestObservedLineup.startedAt)}} · {{data.latestObservedLineup.side==='radiant'?'Radiant':'Dire'}}</p>
          <p class="hint">Источник: {{data.latestObservedLineup.source}} · Синхронизация: {{dateLabel(data.latestObservedLineup.syncedAt)}} · N = 1 карта</p>
          <p v-if="data.latestObservedLineup.status==='incomplete'" class="warning">Состав неполный: не все пять игроков идентифицированы.</p>
          <ul><li v-for="member in data.latestObservedLineup.members" :key="member.playerSlot">
            <RouterLink v-if="member.playerId" :to="`/players/${member.playerId}`">{{member.name?.trim()||'Игрок без ника'}}</RouterLink>
            <span v-else>игрок не идентифицирован</span>
          </li></ul>
          <details><summary>Слоты в протоколе карты</summary><p v-for="member in data.latestObservedLineup.members" :key="member.playerSlot">{{member.name?.trim()||(member.playerId?'Игрок без ника':'Игрок не идентифицирован')}} · слот {{member.playerSlot}}<span v-if="member.playerId"> · внутренний ID игрока {{member.playerId}}</span>. Номер слота не является ролью.</p></details>
        </template>
        <p v-else>Нет доступных завершённых профессиональных карт этой организации. N = 0.</p>
      </template>
      <template v-else>
        <p class="hint">Steam32 в записи каталога: {{data.catalogAccountId || 'неизвестно'}}. Подтверждённый аккаунт и состояние его привязки показаны в блоке команды выше.</p>
        <p class="hint">Сведения источника о команде показаны выше. Профессиональная история игрока следует подтверждённой личности через переходы между организациями.</p>
        <p>История карт и показатели по героям ниже используют проверенные связи аккаунтов и показывают покрытие подтверждённых позиций.</p>
      </template>
      <button type="button" :disabled="isFetching" @click="refetch()">{{isFetching?'Обновление…':'Перечитать базу'}}</button>
    </template>
  </section>
  <ProMapReport v-if="data" :key="kind+id" :kind="kind" :id="id" />
  <RosterReport v-if="data&&kind==='teams'" :key="id" :id="id" />
  <PlayerHeroReport v-if="data&&kind==='players'" :key="id" :id="id" />
  <RankedPractice v-if="data&&kind==='players'" :key="'ranked'+id" :id="id" />
  <StrengthReport v-if="data&&kind==='teams'" :key="'strength'+id" :id="id" />
</template>
