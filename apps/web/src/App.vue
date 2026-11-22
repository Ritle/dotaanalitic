<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ownerAuth } from './auth';
const router=useRouter(),route=useRoute();
const workspace=computed(()=>route.name==='live-draft'||/^\/scenarios\/[^/]+(?:\/draft)?$/.test(route.path)||route.path==='/forecast-journal');
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
  <div class="shell app-shell" :class="{'workspace-shell':workspace}">
    <header class="app-header">
    <div class="eyebrow">PERSONAL ANALYTICS · MVP 2.0</div>
    <h1>Dota 2 Pro Analytics</h1>
    <p>Личный сервис аналитики профессиональных матчей и драфтов.</p>
    <p class="hint" role="status">API: <strong>{{ apiState === 'online' ? 'доступен' : apiState === 'offline' ? 'не отвечает' : 'проверка…' }}</strong></p>
    </header>
    <RouterView />
  </div>
</template>

<style scoped>
.workspace-shell{max-width:1680px;padding:16px 24px}.workspace-shell .app-header{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--color-border);padding-bottom:12px;margin-bottom:16px}
.workspace-shell .app-header h1{font-size:18px;margin:0}.workspace-shell .app-header>.eyebrow,.workspace-shell .app-header>p:not(.hint){display:none}.workspace-shell .app-header .hint{margin:0;font-size:12px}
@media(max-width:680px){.workspace-shell{padding:12px}.workspace-shell .app-header h1{font-size:16px}.workspace-shell .app-header{gap:8px}}
</style>
