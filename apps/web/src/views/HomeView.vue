<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ownerAuth, logout } from '../auth';
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
    <p>Профессиональная статистика и работа с драфтом появятся на следующих этапах.</p>
    <p class="hint">Прогноз недоступен: проверенные модели ещё не опубликованы.</p>
  </section>
</template>
