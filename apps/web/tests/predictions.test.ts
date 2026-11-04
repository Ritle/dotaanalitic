import { afterEach, expect, it, vi } from 'vitest';
import { createPrediction, readPrediction, favouriteLabel, predictionReason } from '../src/predictions';
import { V1PredictionViewSchema } from '@dota/contracts';
import { ownerAuth } from '../src/auth';
import { predictionViewFixture } from '../../../tests/helpers/prediction-view';
import { runtimeFixture } from '../../../packages/db/tests/v1-runtime-fixtures';
afterEach(() => { vi.unstubAllGlobals(); ownerAuth.value = null; });
it('preserves request identity, sends CSRF/cookies and parses a bounded prediction response', async () => {
  const view = predictionViewFixture(), { scenarioId, ...request } = runtimeFixture().request;
  const fetcher = vi.fn(async () => new Response(JSON.stringify(view))); vi.stubGlobal('fetch', fetcher);
  await createPrediction(scenarioId, request, new AbortController().signal);
  await createPrediction(scenarioId, request, new AbortController().signal);
  const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
  expect(calls[0]![1].credentials).toBe('same-origin'); expect(calls[0]![1].headers).toHaveProperty('x-csrf-token');
  expect(calls[0]![1].body).toBe(calls[1]![1].body);
});
it('uses the full probability for the favourite and translates missing identity/history reasons', () => {
  expect(favouriteLabel(0.5000000001)).toBe('Фаворит: команда A');
  expect(favouriteLabel(0.4999999999)).toBe('Фаворит: команда B'); expect(favouriteLabel(0.5)).toBe('Фаворит не определён');
  expect(predictionReason('NO_ACTIVE_MODEL')).toContain('Нет активной');
  expect(predictionReason('CURRENT_IDENTITIES_UNVERIFIED')).toContain('аккаунты');
  expect(predictionReason('INSUFFICIENT_PLAYER_HISTORY')).toContain('5 завершённых');
});
it('rejects expired sessions and unsafe/error bodies without displaying server internals', async () => {
  const { scenarioId, ...request } = runtimeFixture().request;
  vi.stubGlobal('fetch', async () => new Response('internal credential must not appear', { status: 401 }));
  await expect(createPrediction(scenarioId, request, new AbortController().signal)).rejects.toThrow('Сессия завершена');
  vi.stubGlobal('fetch', async () => new Response('internal credential must not appear', { status: 500 }));
  await expect(createPrediction(scenarioId, request, new AbortController().signal)).rejects.toThrow('Сервис не подтвердил сохранение');
  vi.stubGlobal('fetch', async () => new Response('{"privateValue":"must-not-echo"}'));
  await expect(readPrediction('scenarios/test/predictions/test', V1PredictionViewSchema, new AbortController().signal)).rejects.toThrow('Не удалось прочитать сохранённый расчёт');
});
