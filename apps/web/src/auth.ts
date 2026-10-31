import { AuthResponseSchema, type AuthResponse } from '@dota/contracts';
import { ref } from 'vue';

// Only the CSRF token and display state live in memory. Session tokens stay in
// HttpOnly cookies; no credentials/session storage in localStorage or Pinia.
export const ownerAuth = ref<AuthResponse | null>(null);
export class AuthRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function call(path: string, init?: RequestInit) {
  const response = await fetch('/api/v1/auth/' + path, { ...init, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    if (response.status === 401) ownerAuth.value = null;
    const message = response.status === 401 ? 'Неверный логин или пароль. Войдите снова.'
      : response.status === 429 ? 'Слишком много попыток. Повторите вход позже.'
      : response.status === 403 ? 'Сессия проверки безопасности устарела. Обновите страницу.'
      : 'Сервис недоступен. Попробуйте ещё раз.';
    throw new AuthRequestError(response.status, message);
  }
  return response;
}
export async function restoreAuth() {
  try { ownerAuth.value = AuthResponseSchema.parse(await (await call('me')).json()); }
  catch (error) { if (!(error instanceof AuthRequestError && error.status === 401)) throw error; }
}
export async function login(login: string, password: string) {
  const response = await call('login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password }) });
  ownerAuth.value = AuthResponseSchema.parse(await response.json());
}
export async function logout() {
  if (!ownerAuth.value) return;
  await call('logout', { method: 'POST', headers: { 'x-csrf-token': ownerAuth.value.csrfToken } });
  ownerAuth.value = null;
}
