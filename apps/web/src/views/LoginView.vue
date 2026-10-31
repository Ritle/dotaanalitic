<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { login, AuthRequestError } from '../auth';
const router = useRouter();
const loginValue = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');
async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try { await login(loginValue.value, password.value); await router.replace('/'); }
  catch (failure) { error.value = failure instanceof AuthRequestError ? failure.message : 'Не удалось связаться с сервисом. Повторите попытку.'; }
  finally { password.value = ''; busy.value = false; }
}
</script>

<template>
  <section class="panel auth-panel" aria-labelledby="login-heading">
    <h2 id="login-heading">Вход владельца</h2>
    <p>Войдите в личный кабинет аналитики.</p>
    <form @submit.prevent="submit" :aria-busy="busy">
      <label for="login">Логин</label>
      <input id="login" v-model="loginValue" name="username" autocomplete="username" required maxlength="120" :disabled="busy">
      <label for="password">Пароль</label>
      <input id="password" v-model="password" name="password" type="password" autocomplete="current-password" required maxlength="128" :disabled="busy">
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <button type="submit" :disabled="busy">{{ busy ? 'Вход…' : 'Войти' }}</button>
    </form>
  </section>
</template>
