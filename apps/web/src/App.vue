<script setup lang="ts">
import { onMounted, ref } from 'vue';
const apiState = ref<'loading' | 'online' | 'offline'>('loading');
onMounted(async () => {
  try {
    const response = await fetch('/health');
    apiState.value = response.ok ? 'online' : 'offline';
  } catch { apiState.value = 'offline'; }
});
</script>

<template>
  <main class="shell">
    <div class="eyebrow">PERSONAL ANALYTICS · MVP 2.0</div>
    <h1>Dota 2 Pro Analytics</h1>
    <p>Личный сервис аналитики профессиональных матчей и драфтов.</p>
    <section class="panel">
      <h2>Технический каркас</h2>
      <p>API: <strong>{{ apiState === 'online' ? 'доступен' : apiState === 'offline' ? 'не отвечает' : 'проверка…' }}</strong></p>
      <p class="hint">Интерфейс команд, драфтов и предсказаний будет реализован по <code>docs/IMPLEMENTATION_PLAN.md</code>. Демонстрационных прогнозов нет.</p>
    </section>
  </main>
</template>
