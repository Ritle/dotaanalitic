<script setup lang="ts">
import type {V1ScheduleTargetSaved} from '@dota/contracts';
import {dateLabel} from '../catalog';
defineProps<{saved:V1ScheduleTargetSaved}>();
</script>
<template>
  <article aria-label="Сохранённое назначение карты">
    <h2>Карта 1 · назначение {{saved.record.revision}}</h2>
    <p>{{saved.record.observation.match.name??'Встреча'}} · {{dateLabel(saved.record.observation.match.scheduledAt)}}</p>
    <p>A: {{saved.record.teamAName}} · B: {{saved.record.teamBName}}. Локальный турнир: {{saved.record.leagueName??'не выбран'}}.</p>
    <p>Сопоставление команд подтверждено владельцем. A/B не означают Radiant/Dire.</p>
    <p>Назначение сохранено {{dateLabel(saved.record.selectedAt)}}. Само сохранение назначения не запускает расчёт. История попыток показана отдельно.</p>
    <p v-if="saved.record.omittingLaterPages" class="warning">Встреча отсутствовала в {{saved.record.omittingLaterPages}} более поздних частичных ответах. Это не подтверждает отмену.</p>
    <details><summary>Источник и сопоставление</summary>
      <p>PandaScore: встреча #{{saved.record.request.providerMatchId}}, турнир #{{saved.record.observation.match.tournament.providerTournamentId}}. Это не OpenDota series_id.</p>
      <p>Участник #{{saved.record.request.providerTeamAId}} → A #{{saved.record.request.teamAId}}; участник #{{saved.record.request.providerTeamBId}} → B #{{saved.record.request.teamBId}}.</p>
      <p>Получено {{dateLabel(saved.record.observation.fetchedAt)}}, записано {{dateLabel(saved.record.observation.recordedAt)}}. Время первоначального объявления неизвестно.</p>
      <p>{{saved.record.request.reason}} · {{saved.record.request.reviewSourceUrl}}</p>
      <p>Наблюдение #{{saved.record.observation.id}} · SHA {{saved.record.observation.snapshotSha256}}</p>
      <p>SHA назначения {{saved.sha256}}</p>
    </details>
  </article>
</template>
