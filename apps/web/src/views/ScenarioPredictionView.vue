<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ScenarioSnapshotSchema, V1PredictionCreateSchema, V1PredictionViewSchema, V1PredictionHistorySchema, type V1PredictionCreate, type Tier1Scope } from '@dota/contracts';
import { readCatalog, dateLabel } from '../catalog';
import { createPrediction, readPrediction, PredictionRequestError } from '../predictions';
import PredictionResult from '../components/PredictionResult.vue';
import Tier1ScopeSelector from '../components/Tier1ScopeSelector.vue';
const route = useRoute(), router = useRouter(), cache = useQueryClient();
const id = computed(() => String(route.params.id ?? '')), selectedId = computed(() => typeof route.query.prediction === 'string' ? route.query.prediction : '');
const offset = ref(0), busy = ref(false), error = ref(''), conflict = ref(false);
const pending = ref<V1PredictionCreate | null>(null);
const scope = ref<Tier1Scope|null>(null), scopeInvalid=ref(false); let controller: AbortController | null = null;
const scenario = useQuery({ queryKey: computed(() => ['scenario', id.value]),
  queryFn: ({ signal }) => readCatalog(`scenarios/${id.value}`, ScenarioSnapshotSchema, signal) });
const history = useQuery({ queryKey: computed(() => ['predictions', id.value, offset.value]),
  queryFn: ({ signal }) => readPrediction(`scenarios/${id.value}/predictions?offset=${offset.value}`, V1PredictionHistorySchema, signal) });
const saved = useQuery({ queryKey: computed(() => ['prediction', id.value, selectedId.value]), enabled: computed(() => !!selectedId.value && !busy.value),
  queryFn: ({ signal }) => readPrediction(`scenarios/${id.value}/predictions/${selectedId.value}`, V1PredictionViewSchema, signal) });
const selected = computed(() => saved.data.value?.scenario.id === id.value ? saved.data.value : null);
watch(selected, s => { if (s && pending.value?.requestId === s.requestId) {
  pending.value = null; error.value = ''; void cache.invalidateQueries({ queryKey: ['predictions', id.value] });
} });
watch(id, () => { controller?.abort(); busy.value = false; error.value = ''; conflict.value = false; pending.value = null;
  offset.value = 0; scope.value = null; scopeInvalid.value=false; });
onBeforeUnmount(() => controller?.abort());
async function submit(retry = false) {
  error.value = ''; conflict.value = false;
  if (!scenario.data.value || busy.value) return;
  let body = retry ? pending.value : null;
  if (!body) {
    if(scopeInvalid.value){error.value='Заполните проверку турнира: ID лиги OpenDota, название, период UTC, HTTPS-источник и обоснование от 20 символов.';return;}
    try {
      body = V1PredictionCreateSchema.parse({ requestId: crypto.randomUUID(), expectedRevision: scenario.data.value.revision,
        purpose: 'what_if_single_map', targetScope: scope.value });
    } catch { error.value = 'Заполните проверку турнира: ID лиги OpenDota, название, период UTC, HTTPS-источник и обоснование от 20 символов.'; return; }
  }
  const scenarioId = id.value, activeController = new AbortController();
  pending.value = body; busy.value = true; controller = activeController;
  try {
    await router.replace({ query: { prediction: body.requestId } });
    const result = await createPrediction(scenarioId, body, activeController.signal);
    if (id.value !== scenarioId || activeController.signal.aborted) return;
    cache.setQueryData(['prediction', scenarioId, result.requestId], result); pending.value = null;
    offset.value = 0; await cache.invalidateQueries({ queryKey: ['predictions', scenarioId] });
  } catch (e) {
    if (id.value !== scenarioId || activeController.signal.aborted) return;
    error.value = e instanceof PredictionRequestError ? e.message : 'Ответ не получен. Проверьте историю или безопасно повторите тот же запрос.';
    conflict.value = e instanceof PredictionRequestError && e.status === 409;
  } finally { if (id.value === scenarioId && controller === activeController) busy.value = false; }
}
async function refresh() { if (conflict.value) pending.value = null; error.value = ''; conflict.value = false;
  await scenario.refetch(); await history.refetch(); if (selectedId.value) await saved.refetch(); }
</script>
<template>
  <main class="page">
    <RouterLink :to="`/scenarios/${id}`">← Редактор сценария</RouterLink>
    <h1>Расчёт одной карты</h1>
    <p>Предматчевая оценка на выбранных владельцем пятёрках. Расчёт сохраняет составы и данные на момент среза.</p>
    <p v-if="scenario.isPending.value" role="status">Загрузка сценария…</p>
    <p v-if="scenario.error.value" role="alert" class="error">{{ scenario.error.value.message }}</p>
    <section v-if="scenario.data.value" class="panel" aria-label="Новый расчёт">
      <h2>{{ scenario.data.value.input.title }} · редакция {{ scenario.data.value.revision }}</h2>
      <p>Команда A #{{ scenario.data.value.input.teamAId }} — команда B #{{ scenario.data.value.input.teamBId }}.</p>
      <p>Плановое начало: {{ dateLabel(scenario.data.value.input.scheduledAt) }}. Выбранный срез: {{ dateLabel(scenario.data.value.input.cutoffAt) }}.</p>
      <form @submit.prevent="submit()">
        <fieldset :disabled="busy">
          <legend>Проверка турнира</legend>
          <Tier1ScopeSelector :key="id" v-model="scope" :local-league-id="scenario.data.value.input.context.leagueId??null" :scheduled-at="scenario.data.value.input.scheduledAt" @invalid="scopeInvalid=$event" />
          <p class="hint">ID OpenDota сопоставляется с лигой сохранённого сценария. Без проверки турнира попытка сохранится с причиной недоступности.</p>
          <button type="submit">{{ busy ? 'Расчёт и сохранение…' : 'Рассчитать и сохранить попытку' }}</button>
        </fieldset>
      </form>
      <p v-if="busy" role="status">Проверяем модель и профессиональную историю игроков…</p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <button v-if="pending && !conflict && !busy" @click="submit(true)">Повторить тот же запрос</button>
      <button :disabled="busy" @click="refresh">Обновить сценарий и историю</button>
    </section>
    <section class="panel" aria-label="История расчётов">
      <h2>История расчётов</h2>
      <p v-if="history.isFetching.value" role="status">Загрузка истории…</p>
      <p v-if="history.error.value" role="alert" class="error">{{ history.error.value.message }}</p>
      <p v-if="history.data.value && !history.data.value.items.length">Сохранённых расчётов пока нет.</p>
      <ul><li v-for="item in history.data.value?.items" :key="item.id"><RouterLink :to="{ query: { prediction: item.requestId } }" :aria-current="selectedId === item.requestId ? 'page' : undefined">
        {{ dateLabel(item.createdAt) }} · редакция {{ item.scenarioRevision }} · {{ item.status === 'done' ? 'вероятность рассчитана' : 'недоступен' }}
      </RouterLink></li></ul>
      <div class="pagination"><button v-if="offset" @click="offset -= 20">Новые расчёты</button><button v-if="history.data.value?.hasMore" @click="offset += 20">Ранние расчёты</button></div>
    </section>
    <p v-if="selectedId && saved.isFetching.value" role="status">Загрузка сохранённого расчёта…</p>
    <p v-if="selectedId && saved.error.value && !busy && !pending" role="alert" class="error">{{ saved.error.value.message }}</p>
    <p v-if="selected && scenario.data.value && selected.scenario.revision !== scenario.data.value.revision" class="warning">Расчёт относится к редакции {{ selected.scenario.revision }}. Текущая редакция сценария {{ scenario.data.value.revision }}.</p>
    <PredictionResult v-if="selected" :result="selected" />
  </main>
</template>
<style scoped>
.page{min-width:0;overflow-wrap:anywhere}.scope-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4)}
fieldset{min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-4)}label{display:grid;gap:var(--space-2)}
.check{display:flex;align-items:center;gap:var(--space-2)}.check input{width:20px;flex-shrink:0}.panel button{margin:var(--space-2) var(--space-2) 0 0}
li{margin-block:var(--space-3)}ul{padding-left:20px}@media(max-width:600px){.scope-grid{grid-template-columns:1fr}.panel{padding:var(--space-4)}}
</style>
