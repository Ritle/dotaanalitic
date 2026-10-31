<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ownerAuth } from './auth';
const router=useRouter();
watch(ownerAuth,(owner,previous)=>{if(previous && !owner) void router.replace('/login');});
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
    <p class="hint" role="status">API: <strong>{{ apiState === 'online' ? 'доступен' : apiState === 'offline' ? 'не отвечает' : 'проверка…' }}</strong></p>
    <RouterView />
  </main>
</template>
