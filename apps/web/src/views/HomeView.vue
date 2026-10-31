<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ownerAuth, logout } from '../auth';
import CatalogSearch from '../components/CatalogSearch.vue';
const router = useRouter();
const busy = ref(false);
const error = ref('');
async function signOut() {
  busy.value = true; error.value = '';
  try { await logout(); await router.replace('/login'); }
  catch {
    if (!ownerAuth.value) await router.replace('/login');
    else error.value = 'Не удалось завершить сессию. Повторите выход.';
  }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="panel">
    <div class="account-row">
      <h2>Личный кабинет</h2>
      <button type="button" @click="signOut" :disabled="busy">{{ busy ? 'Выход…' : 'Выйти' }}</button>
    </div>
    <p>Владелец: <strong>{{ ownerAuth?.owner.login }}</strong></p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p>Справочники и профессиональная история доступны ниже.</p><RouterLink to="/compare">Сравнить две команды →</RouterLink><p><RouterLink to="/scenarios">Сохранённые сценарии →</RouterLink></p>
    <p class="hint">Прогноз недоступен: проверенные модели ещё не опубликованы.</p>
  </section>
  <CatalogSearch />
</template>
