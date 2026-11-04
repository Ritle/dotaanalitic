<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { V1ModelReadinessSchema } from '@dota/contracts';
import { readCatalog, dateLabel } from '../catalog';
import { predictionReason } from '../predictions';
const readiness = useQuery({ queryKey: ['model-readiness'], queryFn: async ({ signal }) => {
  try { return await readCatalog('models/readiness', V1ModelReadinessSchema, signal); }
  catch { throw new Error('Не удалось проверить статус модели. Повторите проверку.'); }
} });
</script>
<template>
  <section class="panel model-readiness" aria-label="Статус модели">
    <div class="account-row"><h2>Статус модели</h2>
      <button type="button" :disabled="readiness.isFetching.value" @click="readiness.refetch()">Проверить статус модели</button></div>
    <p class="hint">До драфта · одна профессиональная карта</p>
    <p v-if="readiness.isFetching.value || readiness.isPending.value" role="status">Проверяем реестр модели…</p>
    <p v-else-if="readiness.error.value" role="alert" class="error">{{readiness.error.value.message}}</p>
    <template v-else-if="readiness.data.value">
      <p v-if="readiness.data.value.status === 'unavailable'" role="status">{{predictionReason(readiness.data.value.reason)}}</p>
      <p v-else role="status">Модель прошла проверку реестра.</p>
      <p v-if="readiness.data.value.modelId" class="hint model-id">Версия модели: {{readiness.data.value.modelId}}</p>
      <p class="hint">Проверено: {{dateLabel(readiness.data.value.checkedAt)}}</p>
    </template>
    <p class="hint">Это статус реестра, а не прогноз игры. При расчёте отдельно проверяются версия кода, выбранные составы, история игроков и допуск турнира. Вероятность здесь не рассчитывается.</p>
  </section>
</template>
<style scoped>
.model-readiness{margin-block:var(--space-6)}.model-id{overflow-wrap:anywhere}
</style>
