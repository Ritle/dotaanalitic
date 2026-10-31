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
import StrengthReport from '../components/StrengthReport.vue';
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
  <section class="panel">
    <RouterLink to="/">← К справочникам</RouterLink>
    <p v-if="isPending" role="status">Загружаем обзор…</p>
    <div v-else-if="isError" role="alert"><p class="error">{{error?.message}}</p><button type="button" @click="refetch()">Повторить</button></div>
    <template v-else-if="data">
      <p class="eyebrow">{{data.entityType==='organization'?'Организация':'Игрок'}}</p>
      <h2>{{data.entity.name}}</h2>
      <p>ID {{data.entity.id}}<span v-if="data.entity.secondary"> · {{data.entity.secondary}}</span></p>
      <dl class="metadata"><dt>Источник</dt><dd>Локальный справочник</dd><dt>Синхронизация</dt><dd>{{dateLabel(data.entity.syncedAt)}}</dd>
        <dt>Изменение записи</dt><dd>{{dateLabel(data.entity.metadataUpdatedAt)}}</dd><dt>Прочитано</dt><dd>{{dateLabel(data.computedAt)}}</dd></dl>
      <template v-if="data.entityType==='organization'">
        <RouterLink :to="{path:'/compare',query:{teamA:id}}">Сравнить эту организацию с другой →</RouterLink>
        <p class="warning">Организация — не постоянная пятёрка. Актуальный состав неизвестен; его нужно подтвердить для конкретной карты.</p>
        <h3>Последний наблюдавшийся состав</h3>
        <p class="hint">Это участники завершённой pro-карты, а не доказательство предматчевой известности или текущего состава. Роли не назначаются автоматически.</p>
        <template v-if="data.latestObservedLineup">
          <p>Карта {{data.latestObservedLineup.matchId}} · {{dateLabel(data.latestObservedLineup.startedAt)}} · {{data.latestObservedLineup.side==='radiant'?'Radiant':'Dire'}}</p>
          <p class="hint">Источник: {{data.latestObservedLineup.source}} · Синхронизация: {{dateLabel(data.latestObservedLineup.syncedAt)}} · N = 1 карта</p>
          <p v-if="data.latestObservedLineup.status==='incomplete'" class="warning">Состав неполный: не все пять игроков идентифицированы.</p>
          <ul><li v-for="member in data.latestObservedLineup.members" :key="member.playerSlot">
            Слот {{member.playerSlot}}:
            <RouterLink v-if="member.playerId" :to="`/players/${member.playerId}`">{{member.name}} · ID {{member.playerId}}</RouterLink>
            <span v-else>игрок не идентифицирован</span>
          </li></ul>
        </template>
        <p v-else>Нет доступных завершённых профессиональных карт этой организации. N = 0.</p>
      </template>
      <template v-else>
        <p>Canonical player ID: {{data.entity.id}}. Ник не используется для объединения личностей.</p>
        <p>Steam32 из каталога: {{data.catalogAccountId || 'неизвестно'}}. Проверка связи с личностью этим справочником не выполнялась.</p>
        <p class="warning">Текущая команда неизвестна. Профессиональная история игрока следует подтверждённой личности через переходы между организациями.</p>
        <p>История карт и показатели по героям ниже используют проверенные связи аккаунтов и показывают покрытие подтверждённых позиций.</p>
      </template>
      <button type="button" :disabled="isFetching" @click="refetch()">{{isFetching?'Обновление…':'Перечитать базу'}}</button>
    </template>
  </section>
  <ProMapReport v-if="data" :key="kind+id" :kind="kind" :id="id" />
  <RosterReport v-if="data&&kind==='teams'" :key="id" :id="id" />
  <PlayerHeroReport v-if="data&&kind==='players'" :key="id" :id="id" />
  <StrengthReport v-if="data&&kind==='teams'" :key="'strength'+id" :id="id" />
</template>
