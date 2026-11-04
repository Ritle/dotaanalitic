import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { testDatabase } from '../../../../tests/helpers/postgres';
import { sql } from '../../../../packages/db/src/index';
import { buildApp } from '../../../api/src/app';
import { readConfig } from '../../../api/src/config';
import { AuthService } from '../../../api/src/modules/auth/service';
let database: Awaited<ReturnType<typeof testDatabase>>, api: FastifyInstance;
test.beforeEach(async ({ page }) => {
  database = await testDatabase(); const password = randomBytes(24).toString('base64url');
  await new AuthService(database.db).provision('synthetic-readiness-browser', password);
  api = await buildApp(readConfig({ DATABASE_URL: database.url, WEB_ORIGIN: 'http://127.0.0.1:5179' }), { db: database.db, logger: false });
  await api.listen({ host: '127.0.0.1', port: 3151 }); await page.goto('/login');
  await page.getByLabel('Логин').fill('synthetic-readiness-browser'); await page.getByLabel('Пароль').fill(password);
});
test.afterEach(async () => {
  try {
    for (const table of ['scenarios', 'prediction_runs', 'v1_model_artifacts', 'model_activation_events'])
      expect((await sql`SELECT 1 FROM ${sql.table(table)}`.execute(database.db)).rows).toHaveLength(0);
  } finally { await api?.close(); await database?.close(); }
});
test('shows loading then the actual empty registry and UTC check time at desktop and 360px', async ({ page }) => {
  let release = () => {}, seen = () => {};
  const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => seen = r);
  await page.route('**/api/v1/models/readiness', async route => { seen(); await gate; await route.continue(); });
  try {
    await page.getByRole('button', { name: 'Войти', exact: true }).click(); await started;
    const region = page.getByRole('region', { name: 'Статус модели', exact: true });
    await expect(region).toContainText('Проверяем реестр модели…');
    await expect(region.getByRole('button')).toBeDisabled(); release();
    await expect(region).toContainText('Нет активной проверенной модели.'); await expect(region).toContainText(/Проверено: .*UTC/);
    await expect(region).toContainText('Это статус реестра, а не прогноз игры.'); await expect(region).not.toContainText('%');
    await region.screenshot({ path: 'test-results/model-readiness-desktop.png' });
    await page.setViewportSize({ width: 360, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await region.screenshot({ path: 'test-results/model-readiness-mobile.png' });
    await expect(page.getByRole('heading', { name: 'Справочники', exact: true })).toBeVisible();
  } finally { release(); }
});
test('never presents cached eligibility during refresh/failure, handles malformed data and clears auth on 401', async ({ page }) => {
  const modelId = '00000000-0000-4000-8000-000000000001';
  const base = { stage: 'pre_match', checkedAt: '2026-11-03T17:00:00.000Z', modelId, teamAWinProbability: null };
  let phase = 'eligible', release = () => {}, seen = () => {};
  const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => seen = r);
  // Explicitly synthetic HTTP projections, never evidence of an active real model.
  await page.route('**/api/v1/models/readiness', async route => {
    if (phase === 'failure') { seen(); await gate; await route.fulfill({ status: 500, json: { error: 'synthetic-private' } }); }
    else if (phase === 'unauthorized') await route.fulfill({ status: 401, json: {} });
    else await route.fulfill({ json: { ...base, status: phase === 'invalid' ? 'unavailable' : 'model_eligible',
      reason: phase === 'invalid' ? 'ACTIVE_MODEL_EVIDENCE_INVALID' : null, reportSha256: phase === 'invalid' ? null : 'a'.repeat(64),
      ...(phase === 'malformed' ? { teamAWinProbability: 0.5, artifact: 'synthetic-private' } : {}) } });
  });
  try {
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    const region = page.getByRole('region', { name: 'Статус модели', exact: true }), refresh = region.getByRole('button');
    await expect(region).toContainText('Модель прошла проверку реестра.'); await expect(region).toContainText(modelId);
    await expect(region).not.toContainText('%');
    phase = 'failure'; await refresh.click(); await started;
    await expect(region).toContainText('Проверяем реестр модели…'); await expect(region).not.toContainText('Модель прошла проверку реестра.');
    release(); await expect(region.getByRole('alert')).toHaveText('Не удалось проверить статус модели. Повторите проверку.');
    await expect(region).not.toContainText(modelId); await expect(region).not.toContainText('synthetic-private');
    phase = 'invalid'; await refresh.click(); await expect(region).toContainText('Проверка качества активной модели требует пересмотра.');
    phase = 'malformed'; await refresh.click(); await expect(region.getByRole('alert')).toBeVisible();
    await expect(region).not.toContainText('Модель прошла проверку реестра.'); await expect(region).not.toContainText('synthetic-private');
    phase = 'unauthorized'; await refresh.click(); await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('region', { name: 'Статус модели', exact: true })).toHaveCount(0);
  } finally { release(); }
});
