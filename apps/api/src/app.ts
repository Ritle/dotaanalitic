import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readConfig } from './config.js';
import { createDatabase, CatalogRepository, ProMapRepository, RosterRepository, PlayerHeroRepository, StrengthRepository, CompareRepository, ScenarioRepository, HeroMatchupRepository, type Db } from '@dota/db';
import { AuthError, AuthService } from './modules/auth/service.js';
import { registerAuth } from './modules/auth/http.js';
import { registerCatalog } from './modules/catalog/http.js';
import { registerProMaps } from './modules/catalog/pro-maps-http.js';
import { registerRoster } from './modules/catalog/roster-http.js';
import { registerPlayerHeroes } from './modules/catalog/player-hero-http.js';
import { registerStrength } from './modules/catalog/strength-http.js';
import { registerCompare } from './modules/catalog/compare-http.js';
import { registerScenarios } from './modules/scenarios/http.js';
import { registerHeroMatchups } from './modules/scenarios/hero-matchups-http.js';
import { registerReports } from './modules/scenarios/reports-http.js';
import {ScenarioReportRepository} from '@dota/db';
import type { FastifyServerOptions } from 'fastify';
import {UpcomingService} from './modules/upcoming/service.js';
import {registerUpcoming} from './modules/upcoming/http.js';

export async function buildApp(config = readConfig(), options: { db?: Db; logger?: FastifyServerOptions['logger'];pandascoreFetch?:(url:URL,init:RequestInit)=>Promise<Response> } = {}) {
  const app = Fastify({ bodyLimit: 8192, trustProxy: false, logger: options.logger === false ? false : {
    ...(typeof options.logger === 'object' ? options.logger : {}),
    redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
    serializers: { req: request => ({ method: request.method, url: request.url?.split('?')[0], remoteAddress: request.ip }) }
  } });
  const db = options.db ?? createDatabase(config.DATABASE_URL);
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  if (!options.db) app.addHook('onClose', async () => db.destroy());
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    let status = 500, code = 'INTERNAL_ERROR', message = 'Не удалось выполнить запрос. Попробуйте позже.';
    if (error instanceof AuthError) {
      status = error.code === 'RATE_LIMITED' ? 429 : 401;
      code = error.code;
      message = status === 429 ? 'Слишком много попыток входа. Повторите позже.' : 'Требуется вход или указан неверный логин и пароль.';
      if (error.retryAfter) reply.header('Retry-After', error.retryAfter);
    } else if (statusCode === 403) { status = 403; code = 'FORBIDDEN'; message = 'Проверка безопасности запроса не пройдена. Обновите страницу.'; }
    else if (statusCode === 429) { status = 429; code = 'RATE_LIMITED'; message = 'Слишком много запросов. Повторите позже.'; }
    else if (statusCode === 400 || statusCode === 413 || statusCode === 415) {
      status = statusCode; code = 'VALIDATION_ERROR'; message = 'Некорректный формат запроса.';
    }
    request.log[status >= 500 ? 'error' : 'info']({ event: 'request_rejected', request_id: request.id, code, status });
    return reply.code(status).send({ error: { code, message, requestId: request.id } });
  });
  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true
  });
  app.get('/health', async () => ({ status: 'ok', service: 'dota2-pro-analytics-api' }));
  await registerAuth(app, config, new AuthService(db));
  registerCatalog(app, new CatalogRepository(db));
  registerProMaps(app, new ProMapRepository(db));
  registerRoster(app, new RosterRepository(db));
  registerPlayerHeroes(app, new PlayerHeroRepository(db));
  registerStrength(app, new StrengthRepository(db));
  registerCompare(app, new CompareRepository(db));
  registerScenarios(app, new ScenarioRepository(db));
  registerHeroMatchups(app, new HeroMatchupRepository(db));
  registerReports(app,new ScenarioReportRepository(db));
  registerUpcoming(app,new UpcomingService(db,config.PANDASCORE_API_TOKEN,options.pandascoreFetch));
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден.', requestId: request.id } }));
  return app;
}
