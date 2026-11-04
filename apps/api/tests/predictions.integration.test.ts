import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { V1PredictionViewSchema, V1PredictionHistorySchema } from '@dota/contracts';
import { ScenarioRepository, V1RuntimeRepository, V1PredictionService, sql } from '@dota/db';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { seedPredictionScenario } from '../../../tests/helpers/predictions.js';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { AuthService } from '../src/modules/auth/service.js';
let database: Awaited<ReturnType<typeof testDatabase>>, app: FastifyInstance, cookie: string, csrf: string, owner: string, id: string;
const path = () => `/api/v1/scenarios/${id}/predictions`;
const headers = () => ({ cookie, origin: 'http://localhost:5173', 'x-csrf-token': csrf });
const body = () => ({ requestId: randomUUID(), expectedRevision: 1, purpose: 'what_if_single_map', targetScope: null });
const post = (payload: unknown = body()) => app.inject({ method: 'POST', url: path(), headers: headers(), payload });
const get = (url = path()) => app.inject({ url, headers: { cookie } });
beforeEach(async () => {
  database = await testDatabase(); const input = await seedPredictionScenario(database.db), password = randomBytes(24).toString('base64url');
  owner = (await new AuthService(database.db).provision('synthetic-prediction-owner', password)).id;
  id = (await new ScenarioRepository(database.db).save(owner, input)).id;
  app = await buildApp(readConfig({ DATABASE_URL: database.url }), { db: database.db, logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost:5173' }, payload: { login: 'synthetic-prediction-owner', password } });
  const cookies = login.headers['set-cookie']; cookie = (Array.isArray(cookies) ? cookies : [cookies ?? '']).map(c => c.split(';')[0]).join('; '); csrf = login.json().csrfToken;
}, 30000);
afterEach(async () => { await app?.close(); await database?.close(); }, 30000);
test('requires owner/session/CSRF/origin for all routes and rejects forged fields before creating attempts', async () => {
  for (const url of [path(), path() + '/' + randomUUID()]) expect((await app.inject({ url })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: path(), headers: { cookie, origin: 'http://localhost:5173' }, payload: body() })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: path(), headers: { ...headers(), origin: 'https://example.test' }, payload: body() })).statusCode).toBe(403);
  for (const payload of [{ ...body(), modelId: randomUUID() }, { ...body(), purpose: 'real_map' }, { ...body(), teamAWinProbability: 0.9 }]) expect((await post(payload)).statusCode).toBe(400);
  expect((await sql`SELECT 1 FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
test('creates an unavailable snapshot, returns exact retry/read after edits, and exposes only a bounded projection', async () => {
  const request = body(), response = await post(request); expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  const saved = V1PredictionViewSchema.parse(response.json()); expect(saved.status).toBe('unavailable'); expect(saved.teamAWinProbability).toBeNull();
  expect(saved.reasons).toContain('NO_ACTIVE_MODEL'); expect(saved.model.id).toBeNull();
  expect(response.body).not.toMatch(/source_payload|candidateText|barrels|code\/|sourceAccountId/);
  expect((await post(request)).json()).toEqual(saved);
  expect((await get(path() + '/' + request.requestId)).json()).toEqual(saved);
  const scenario = await new ScenarioRepository(database.db).get(owner, id);
  await new ScenarioRepository(database.db).save(owner, { ...scenario.input, title: 'Synthetic edited' }, { id, expectedRevision: 1 });
  expect((await post(request)).json()).toEqual(saved);
  expect((await post({ ...request, expectedRevision: 2 })).statusCode).toBe(409);
  expect((await post(body())).statusCode).toBe(409);
  const history = V1PredictionHistorySchema.parse((await get()).json()); expect(history.items).toHaveLength(1); expect(history.items[0]?.scenarioRevision).toBe(1);
});
test('validates IDs/paging and hides snapshots belonging to another scenario or owner', async () => {
  const saved = V1PredictionViewSchema.parse((await post()).json());
  expect((await get(path() + '?offset=-1')).statusCode).toBe(400);
  expect((await get(path() + '/not-a-uuid')).statusCode).toBe(400);
  expect((await get(`/api/v1/scenarios/${randomUUID()}/predictions/${saved.requestId}`)).statusCode).toBe(404);
  // The DB deliberately forbids a second owner. Exercise ownership predicates using a
  // foreign identity directly, and verify that HTTP cannot supply/override the session owner.
  const other = randomUUID(), service = await V1PredictionService.open(database.db);
  await expect(service.history(other, id, 0)).rejects.toThrow('NOT_FOUND');
  await expect(service.get(other, id, saved.requestId)).rejects.toThrow('NOT_FOUND');
  await expect(service.create(other, { ...body(), scenarioId: id })).rejects.toThrow('NOT_FOUND');
  expect((await post({ ...body(), ownerId: other })).statusCode).toBe(400);
});
test('rate-limits expensive POST attempts with Retry-After and keeps reads available', async () => {
  const request = body();
  for (let i = 0; i < 6; i++) expect((await post(request)).statusCode).toBe(200);
  const limited = await post(request); expect(limited.statusCode).toBe(429); expect(limited.headers['retry-after']).toBeDefined();
  expect((await get(path() + '/' + request.requestId)).statusCode).toBe(200);
});
test('history is paged in persisted timestamp order without truncating or duplicating attempts', async () => {
  const repo = new V1RuntimeRepository(database.db), ids: string[] = [];
  for (let i = 0; i < 21; i++) ids.push((await repo.create(owner, { ...body(), scenarioId: id })).id);
  const first = V1PredictionHistorySchema.parse((await get()).json()), second = V1PredictionHistorySchema.parse((await get(path() + '?offset=20')).json());
  expect(first.items).toHaveLength(20); expect(first.hasMore).toBe(true); expect(second.items).toHaveLength(1); expect(second.hasMore).toBe(false);
  expect([...first.items, ...second.items].map(r => r.id)).toEqual(ids.reverse());
}, 30000);
