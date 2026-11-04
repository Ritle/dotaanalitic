import { V1PredictionViewSchema, type V1PredictionCreate } from '@dota/contracts';
import { ownerAuth, AuthRequestError } from './auth';
import { queryClient } from './query-client';
import { readCatalog, CatalogRequestError } from './catalog';
export class PredictionRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export async function readPrediction<T>(path: string, schema: { parse(value: unknown): T }, signal: AbortSignal) {
  try { return await readCatalog(path, schema, signal); }
  catch (error) {
    if (signal.aborted || error instanceof CatalogRequestError || error instanceof AuthRequestError) throw error;
    throw new Error('Не удалось прочитать сохранённый расчёт. Обновите страницу или повторите запрос.');
  }
}
export async function createPrediction(scenarioId: string, body: V1PredictionCreate, signal: AbortSignal) {
  const response = await fetch(`/api/v1/scenarios/${scenarioId}/predictions`, { method: 'POST', credentials: 'same-origin',
    cache: 'no-store', signal, headers: { 'content-type': 'application/json', 'x-csrf-token': ownerAuth.value?.csrfToken ?? '' }, body: JSON.stringify(body) });
  if (response.status === 401) {
    ownerAuth.value = null; queryClient.clear(); throw new AuthRequestError(401, 'Сессия завершена. Войдите снова.');
  }
  if (!response.ok) throw new PredictionRequestError(response.status,
    response.status === 409 ? 'Редакция сценария или параметры запроса изменились. Обновите сценарий и начните новый расчёт.' :
    response.status === 403 ? 'Проверка сессии устарела. Обновите страницу.' :
    response.status === 404 ? 'Сценарий не найден.' : response.status === 400 ? 'Проверьте редакцию сценария и сведения о турнире.' :
    response.status === 429 ? 'Слишком много расчётов. Повторите через минуту.' : 'Сервис не подтвердил сохранение. Можно безопасно повторить тот же запрос.');
  return V1PredictionViewSchema.parse(await response.json());
}
const messages: Record<string, string> = {
  NO_ACTIVE_MODEL: 'Нет активной проверенной модели.',
  ACTIVE_MODEL_EVIDENCE_INVALID: 'Проверка качества активной модели требует пересмотра.',
  TARGET_START_UNKNOWN: 'Укажите плановое начало карты в сценарии.',
  TARGET_ALREADY_STARTED: 'Плановое начало карты уже наступило.',
  TARGET_SERIES_ALREADY_STARTED:'Для этой встречи уже известна начавшаяся карта. Новый прогноз до игры недоступен.',
  TARGET_OWNER_CANCELLED:'Владелец отметил отмену встречи. Новая вероятность не выдаётся до повторного открытия.',
  TIER1_SCOPE_NOT_REVIEWED: 'Турнир ещё не подтверждён как Tier 1.',
  TARGET_OUTSIDE_REVIEWED_TIER1_SCOPE: 'Лига или дата карты не совпадает с проверенным турниром Tier 1.',
  BETWEEN_MAP_PREDICTION_UNSUPPORTED: 'Расчёт между картами начавшейся серии пока не поддерживается.',
  CURRENT_IDENTITIES_UNVERIFIED: 'Не удалось однозначно подтвердить аккаунты всех десяти игроков.',
  IDENTITY_UNVERIFIED: 'Аккаунт игрока не подтверждён.', IDENTITY_CONFLICT: 'Источники привязки аккаунта противоречат друг другу.',
  CROSS_ACCOUNT_HISTORY_UNSUPPORTED: 'Найдены разные аккаунты одного игрока; их история требует проверки.',
  INSUFFICIENT_PLAYER_HISTORY: 'Для каждого игрока нужно минимум 5 завершённых профессиональных карт до среза.',
  LINEUP_AFTER_SNAPSHOT: 'Состав сохранён после выбранного среза данных. Обновите срез в сценарии.',
  LINEUP_NOT_SELECTED_BEFORE_START: 'Состав должен быть сохранён до среза и начала карты. Проверьте даты сценария.',
  HISTORY_WINDOW_INVALID: 'Выбранный срез предшествует доступному периоду истории.', NO_HISTORY_WINDOW: 'Нет допустимого периода истории до среза.',
  HISTORY_INVENTORY_LIMIT: 'Объём локальной истории превышает лимит полного расчёта.',
  HISTORY_EVIDENCE_INVALID: 'Не удалось проверить целостность профессиональной истории.',
  INFERENCE_CODE_MISMATCH: 'Расчётный код не соответствует проверенной версии модели.',
  SERVER_CODE_CHANGED_RESTART_REQUIRED: 'Серверный код обновлён. Для нового расчёта требуется перезапуск API.',
  INFERENCE_UNAVAILABLE: 'Модель не смогла рассчитать вероятность для этого состава.'
};
export const predictionReason = (code: string) => messages[code] ?? 'Расчёт требует дополнительной проверки данных.';
export const probabilityLabel = (value: number) => new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 2 }).format(value);
export const favouriteLabel = (value: number) => value === 0.5 ? 'Фаворит не определён' : value > 0.5 ? 'Фаворит: команда A' : 'Фаворит: команда B';
