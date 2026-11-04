<script setup lang="ts">
import type { V1PredictionView } from '@dota/contracts';
import { dateLabel } from '../catalog';
import { predictionReason, probabilityLabel, favouriteLabel } from '../predictions';
defineProps<{ result: Omit<V1PredictionView,'purpose'> & {purpose:'what_if_single_map'|'real_map'} }>();
</script>
<template>
  <article class="panel prediction-result" aria-label="Сохранённый расчёт">
    <p class="eyebrow">ДО ДРАФТА · ОДНА КАРТА</p>
    <h2>{{ result.status === 'done' ? 'Вероятность победы на карте' : 'Прогноз недоступен' }}</h2>
    <p>{{ result.purpose==='real_map'?'Прогноз для назначенной карты':'Условный сценарий' }}: результат относится к выбранным 5+5. Фактическое участие этих игроков может измениться.</p>
    <div v-if="result.status === 'done' && result.teamAWinProbability !== null" class="probabilities" aria-label="Вероятности победы">
      <p><span>Команда A</span><strong>{{ probabilityLabel(result.teamAWinProbability) }}</strong></p>
      <p><span>Команда B</span><strong>{{ probabilityLabel(1 - result.teamAWinProbability) }}</strong></p>
      <p>{{ favouriteLabel(result.teamAWinProbability) }}</p>
    </div>
    <ul v-if="result.reasons.length" aria-label="Причины недоступности"><li v-for="reason in result.reasons" :key="reason">{{ predictionReason(reason) }}</li></ul>
    <p><strong>{{ result.scenario.input.title }}</strong> · сохранённая редакция {{ result.scenario.revision }}</p>
    <div class="lineups">
      <section v-for="slot in (['A','B'] as const)" :key="slot" :aria-label="`Сохранённый состав ${slot}`">
        <h3>Команда {{ slot }} · <RouterLink :to="`/teams/${slot === 'A' ? result.scenario.input.teamAId : result.scenario.input.teamBId}`">#{{ slot === 'A' ? result.scenario.input.teamAId : result.scenario.input.teamBId }}</RouterLink></h3>
        <ul><li v-for="p in (slot === 'A' ? result.scenario.input.lineupA : result.scenario.input.lineupB)" :key="p.playerId!">
          <RouterLink :to="`/players/${p.playerId}`">Игрок #{{ p.playerId }}</RouterLink>
          <template v-if="result.players"> · N={{ (slot === 'A' ? result.players.teamA : result.players.teamB).find(row => row.playerId === p.playerId)?.maps ?? 'неизвестно' }}</template>
        </li></ul>
      </section>
    </div>
    <section aria-label="Покрытие данных расчёта">
      <h3>Профессиональная история</h3>
      <p v-if="result.coverage">Завершённых карт в истории: N={{ result.coverage.nRaw }}; эффективный N={{ result.coverage.nEff }}.
        Минимум 5 карт есть у {{ result.coverage.playersMeetingMinimum }} из 10 игроков; наименьшая личная выборка — {{ result.coverage.minimumPlayerMaps }}.</p>
      <p v-else>Покрытие игроков не удалось определить.</p>
      <p v-if="result.history">Период: {{ dateLabel(result.history.fromAt) }} — {{ dateLabel(result.history.toAt) }}.
        Источник: локальная проверенная pro-история всех уровней турниров; составы завершённых карт восстановлены по результатам.
        Снимок источников: {{ dateLabel(result.history.snapshotAt) }}. Полнота удалённой истории неизвестна.</p>
      <p v-else>Снимок истории недоступен.</p>
    </section>
    <p>Срез расчёта: {{ dateLabel(result.cutoffAt) }}. Плановое начало: {{ dateLabel(result.scenario.input.scheduledAt) }}.</p>
    <p>Сохранён: {{ dateLabel(result.createdAt) }}<template v-if="result.issuedAt">. Вероятность выдана: {{ dateLabel(result.issuedAt) }}</template>.</p>
    <p v-if="result.targetScope">Турнир Tier 1: {{ result.targetScope.eventName }} · <a :href="result.targetScope.sourceUrl" target="_blank" rel="noopener noreferrer">источник проверки владельца</a>.</p>
    <p>Модель: Player Elo V1. {{ result.model.id ? `Версия ${result.model.id}.` : 'Активная версия отсутствовала.' }}</p>
    <p v-if="result.purpose==='what_if_single_map'" class="hint">Этот условный расчёт сохраняется отдельно от статистики прогнозов реальных карт. Правка сценария создаёт новую редакцию и не изменяет этот результат.</p>
    <p v-else class="hint">Попытка сохранена для реальной карты. В статистику точности попадёт только выданный до фактического старта прогноз с проверенным результатом. Правка сценария не изменяет эту запись.</p>
  </article>
</template>
<style scoped>
.prediction-result{min-width:0;overflow-wrap:anywhere}.lineups,.probabilities{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4)}
.probabilities p{display:grid;gap:var(--space-2)}.probabilities strong{font-size:2rem;color:var(--color-text)}
li{margin-block:var(--space-2)}ul{padding-left:20px}h3{font-size:1rem}@media(max-width:600px){.lineups,.probabilities{grid-template-columns:1fr}.panel{padding:var(--space-4)}}
</style>
