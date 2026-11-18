<script setup lang="ts">
import {ref} from 'vue';
import type {ScenarioSnapshot} from '@dota/contracts';
import {dateLabel} from '../catalog';
import {roleName} from '../role-suggestions';
import DraftAssessment from './DraftAssessment.vue';
import ScenarioDisplayLabels from './ScenarioDisplayLabels.vue';
import ReportEntityLabel from './ReportEntityLabel.vue';
defineProps<{snapshot:ScenarioSnapshot}>();
const open=ref(false);
</script>
<template>
 <details @toggle="open=($event.currentTarget as HTMLDetailsElement).open">
  <summary>Редакция {{snapshot.revision}} · {{snapshot.input.title}} · {{dateLabel(snapshot.recordedAt)}}</summary>
  <ScenarioDisplayLabels v-if="open" :input="snapshot.input" include-heroes v-slot="{labels}">
   <p>Срез: {{dateLabel(snapshot.input.cutoffAt)}}. Radiant: {{snapshot.input.context.radiantSlot??'неизвестно'}}; первый пик: {{snapshot.input.context.firstPickSlot??'неизвестно'}}.</p>
   <div v-for="slot in (['A','B'] as const)" :key="slot">
    <h3>Состав {{slot}}</h3><ReportEntityLabel kind="teams" :id="slot==='A'?snapshot.input.teamAId:snapshot.input.teamBId" :name="labels['team:'+(slot==='A'?snapshot.input.teamAId:snapshot.input.teamBId)]" />
    <div v-for="p in (slot==='A'?snapshot.input.lineupA:snapshot.input.lineupB)" :key="p.rolePos"><p>Роль {{p.rolePos}} · {{roleName(p.rolePos)}}{{p.isStandin?' · замена':''}}</p><ReportEntityLabel kind="players" :id="p.playerId" :name="labels['player:'+p.playerId]" /></div>
   </div>
   <p>Плановое начало: {{dateLabel(snapshot.input.scheduledAt)}}. Серия: {{snapshot.input.context.seriesId??'неизвестно'}}; карта: {{snapshot.input.context.mapNumber??'неизвестно'}}; счёт до карты A / B: {{snapshot.input.context.teamASeriesWinsBefore??'неизвестно'}} / {{snapshot.input.context.teamBSeriesWinsBefore??'неизвестно'}}.</p>
   <p>Формат: {{snapshot.input.context.venueKind==='lan'?'LAN':snapshot.input.context.venueKind==='online'?'Онлайн':snapshot.input.context.venueKind==='hybrid'?'Смешанный':'неизвестно'}}; стадия: {{snapshot.input.context.tournamentStage??'неизвестно'}}.</p>
   <p v-if="!snapshot.input.draft">Драфт не входил в эту редакцию.</p>
   <div v-else role="group" aria-label="Герои драфта редакции"><p>Лига: {{snapshot.input.context.leagueId??'неизвестно'}}. Назначено героев: {{snapshot.input.draft.assignments.length}} / 10.</p>
    <div v-for="h in snapshot.input.draft.assignments" :key="h.teamSlot+h.rolePos" class="history-draft-hero" :data-history-hero-id="h.heroId" data-history-draft-action="pick"><span>{{h.teamSlot}} · роль {{h.rolePos}} · </span><ReportEntityLabel kind="heroes" :id="String(h.heroId)" :name="labels['hero:'+h.heroId]" /></div>
    <div v-for="h in snapshot.input.draft.bans" :key="h.heroId" class="history-draft-hero" :data-history-hero-id="h.heroId" data-history-draft-action="ban"><span>Бан {{h.teamSlot}} · </span><ReportEntityLabel kind="heroes" :id="String(h.heroId)" :name="labels['hero:'+h.heroId]" /></div>
    <DraftAssessment v-if="snapshot.draftAssessment" :assessment="snapshot.draftAssessment" :hero-labels="labels" saved />
   </div>
   <div v-for="slot in (['A','B'] as const)" :key="`expected-${slot}`"><h3>Ожидаемый состав {{slot}}</h3>
    <p v-if="!(slot==='A'?snapshot.input.expectedLineupA:snapshot.input.expectedLineupB)">Не задан</p>
    <div v-for="p in (slot==='A'?snapshot.input.expectedLineupA:snapshot.input.expectedLineupB)" :key="p.rolePos"><p>Роль {{p.rolePos}} · {{roleName(p.rolePos)}}</p><ReportEntityLabel kind="players" :id="p.playerId" :name="labels['player:'+p.playerId]" /></div>
   </div>
  </ScenarioDisplayLabels>
 </details>
</template>
<style scoped>summary{cursor:pointer;min-height:44px;padding-block:10px}.history-draft-hero{margin-block:8px;overflow-wrap:anywhere}</style>
