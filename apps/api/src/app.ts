import {registerLiveSchedule} from './modules/live/http.js';
import {LiveScheduleService} from './modules/live/service.js';
import {LiveEstimateService} from './modules/live/estimate-service.js';
import {registerLiveEstimates} from './modules/live/estimate-http.js';
import {UnclassifiedScheduledForecastService} from './modules/upcoming/unclassified-scheduled-runtime.js';
import {V1AnyRuntimeRequestSchema,V1ScheduledPredictionCreateSchema} from '@dota/contracts';
import {QuickForecastService} from './modules/upcoming/quick-forecast.js';
import {registerQuickForecast} from './modules/upcoming/quick-forecast-http.js';
import {registerSeriesReadiness,SeriesReadinessService} from './modules/upcoming/series-readiness.js';
import {ComparisonHistoryService,registerComparisonHistory} from './modules/history/comparison-history.js';
import type {PlayerHistoryProvider} from '@dota/ingestion';
import {registerLineupTemplates} from './modules/catalog/lineup-templates-http.js';
import {LineupTemplateRepository} from './modules/catalog/lineup-templates-repository.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readConfig } from './config.js';
import { createDatabase, CatalogRepository, ProMapRepository, RosterRepository, PlayerHeroRepository, StrengthRepository, CompareRepository, ScenarioRepository, HeroMatchupRepository, type Db } from '@dota/db';
import { AuthError, AuthService } from './modules/auth/service.js';
import { registerAuth } from './modules/auth/http.js';
import { registerCatalog } from './modules/catalog/http.js';
import {registerDisplayLabels} from './modules/catalog/display-labels-http.js';
import {registerContextCatalog} from './modules/catalog/context-catalog-http.js';
import {registerRosterContext} from './modules/catalog/roster-context-http.js';
import {RosterContextService} from './modules/catalog/roster-context-service.js';
import {registerTeamActivity} from './modules/catalog/team-activity-http.js';
import {TeamActivityRepository} from './modules/catalog/team-activity-repository.js';
import { registerProMaps } from './modules/catalog/pro-maps-http.js';
import { registerRoster } from './modules/catalog/roster-http.js';
import { registerPlayerHeroes } from './modules/catalog/player-hero-http.js';
import { registerStrength } from './modules/catalog/strength-http.js';
import { registerCompare } from './modules/catalog/compare-http.js';
import { registerScenarios } from './modules/scenarios/http.js';
import {registerDraftCaptures} from './modules/scenarios/draft-capture-http.js';
import {DraftCaptureRepository} from './modules/scenarios/draft-capture-repository.js';
import {registerDraftNativeBindings} from './modules/scenarios/draft-native-http.js';
import {DraftNativeRepository} from './modules/scenarios/draft-native-repository.js';
import { registerHeroMatchups } from './modules/scenarios/hero-matchups-http.js';
import { registerReports } from './modules/scenarios/reports-http.js';
import {ScenarioReportRepository} from '@dota/db';
import {V1PredictionService} from '@dota/db';
import {registerPredictions} from './modules/scenarios/predictions-http.js';
import {V1JournalService} from '@dota/db';
import {registerJournal} from './modules/scenarios/journal-http.js';
import {registerJournalFeed} from './modules/scenarios/journal-feed-http.js';
import {registerJournalResults} from './modules/scenarios/journal-result-http.js';
import {JournalResultService} from './modules/scenarios/journal-result-service.js';
import type { FastifyServerOptions, FastifyReply } from 'fastify';
import {UpcomingService} from './modules/upcoming/service.js';
import {registerUpcoming} from './modules/upcoming/http.js';
import {FreshPageScheduleTargetRepository,PageScheduledPredictionService} from '@dota/db';
import {registerScheduleTargets} from './modules/upcoming/targets-http.js';
import {registerTier1Scopes} from './modules/upcoming/tier1-scopes-http.js';
import {Tier1ScopeRepository} from '@dota/db';
import {registerScheduledForecasts} from './modules/upcoming/forecasts-http.js';
import {registerScheduledResults} from './modules/upcoming/results-http.js';
import {registerScheduledLifecycle} from './modules/upcoming/lifecycle-http.js';
import {V1ScheduledLifecycleService} from '@dota/db';
import {V1ScheduledResultService} from '@dota/db';
import {HistoryRefreshService} from './modules/history/service.js';
import {registerHistoryRefresh} from './modules/history/http.js';
import {registerPlayerHistory,PlayerHistoryService} from './modules/history/player-history.js';
import {PredictionModelRegistry} from '@dota/db';
import {registerModelReadiness} from './modules/models/readiness-http.js';
import {RoleSuggestionRepository} from '@dota/db';
import {registerRoleSuggestions} from './modules/catalog/role-suggestions-http.js';
import {RoleProfileService} from './modules/catalog/role-profile-service.js';
import {registerRoleProfiles} from './modules/catalog/role-profiles-http.js';
import {RankedPracticeService,registerRankedPractice} from './modules/catalog/ranked-practice.js';
import {registerRosterCatalogue} from './modules/upcoming/catalogue-http.js';
import {RosterCatalogueService,liveCatalogueProvider,type CatalogueProvider} from './modules/upcoming/catalogue-service.js';

export async function buildApp(config = readConfig(), options: { db?: Db; logger?: FastifyServerOptions['logger'];pandascoreFetch?:(url:URL,init:RequestInit)=>Promise<Response>;roleProfileFetch?:typeof fetch;rankedPracticeFetch?:typeof fetch;catalogueProvider?:CatalogueProvider;playerHistoryProvider?:(signal:AbortSignal)=>PlayerHistoryProvider } = {}) {
  const app = Fastify({ bodyLimit: 8192, trustProxy: false, logger: options.logger === false ? false : {
    ...(typeof options.logger === 'object' ? options.logger : {}),
    redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
    serializers: { req: request => ({ method: request.method, url: request.routeOptions?.url ?? '[unmatched]', remoteAddress: request.ip }) }
  },
  // Router failures happen before auth/onSend/error hooks. Never reflect their
  // raw path/message, and apply no-store explicitly at this boundary.
  frameworkErrors(error, request, reply: FastifyReply) {
    const tooLong = error.code === 'FST_ERR_MAX_PARAM_LENGTH';
    const badUrl = error.code === 'FST_ERR_BAD_URL';
    const status = tooLong ? 414 : badUrl ? 400 : 500;
    const code = tooLong ? 'URI_TOO_LONG' : badUrl ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
    request.log[status >= 500 ? 'error' : 'info']({ event: 'request_rejected', request_id: request.id, code, status });
    return reply.header('Cache-Control', 'no-store').code(status).send({ error: { code, requestId: request.id,
      message: tooLong ? 'Слишком длинный адрес запроса.' : badUrl ? 'Некорректный адрес запроса.' : 'Не удалось выполнить запрос. Попробуйте позже.' } });
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
  const playerHistory=new PlayerHistoryService(db,config.DATABASE_URL,options.playerHistoryProvider);
  registerPlayerHistory(app,playerHistory);
  registerComparisonHistory(app,new ComparisonHistoryService(db,playerHistory));
  app.addHook('onClose',()=>playerHistory.close());
  registerCatalog(app, new CatalogRepository(db));
  registerDisplayLabels(app,db);
  registerContextCatalog(app,db);
  registerRoleSuggestions(app,new RoleSuggestionRepository(db));
  registerRoleProfiles(app,new RoleProfileService(db,config,options.roleProfileFetch));
  registerRankedPractice(app,new RankedPracticeService(db,config,options.rankedPracticeFetch));
  registerProMaps(app, new ProMapRepository(db));
  registerRoster(app, new RosterRepository(db));
  registerPlayerHeroes(app, new PlayerHeroRepository(db));
  registerStrength(app, new StrengthRepository(db));
  registerCompare(app, new CompareRepository(db));
  registerScenarios(app, new ScenarioRepository(db));
  registerDraftCaptures(app,new DraftCaptureRepository(db),db);
  registerDraftNativeBindings(app,new DraftNativeRepository(db));
  registerHeroMatchups(app, new HeroMatchupRepository(db));
  registerReports(app,new ScenarioReportRepository(db));
  const predictions=await V1PredictionService.open(db);
  const pagePredictions=await PageScheduledPredictionService.open(db,predictions);
  const optionalTier=new UnclassifiedScheduledForecastService(db);
  const interactivePredictions={
    create:(owner:string,raw:unknown)=>V1AnyRuntimeRequestSchema.parse(raw).targetScope===null?optionalTier.create(owner,raw):pagePredictions.create(owner,raw),
    createScheduled:(owner:string,id:string,raw:unknown)=>V1ScheduledPredictionCreateSchema.parse(raw).targetScope===null?optionalTier.createScheduled(owner,id,raw):pagePredictions.createScheduled(owner,id,raw),
    get:pagePredictions.get.bind(pagePredictions),history:pagePredictions.history.bind(pagePredictions),
    getScheduled:pagePredictions.getScheduled.bind(pagePredictions),scheduledHistory:pagePredictions.scheduledHistory.bind(pagePredictions)
  };
  registerPredictions(app,interactivePredictions);
  const freshScheduleTargets=new FreshPageScheduleTargetRepository(db);
  registerScheduledForecasts(app,interactivePredictions,freshScheduleTargets);
  registerScheduledResults(app,new V1ScheduledResultService(db,predictions));
  registerScheduledLifecycle(app,new V1ScheduledLifecycleService(db));
  registerJournal(app,await V1JournalService.open(db));
  registerJournalFeed(app,db);
  registerJournalResults(app,new JournalResultService(db,config.PANDASCORE_API_TOKEN,options.pandascoreFetch));
  const liveService=new LiveScheduleService(db,config.PANDASCORE_API_TOKEN,options.pandascoreFetch);
  registerLiveSchedule(app,liveService);
  registerLiveEstimates(app,new LiveEstimateService(db,liveService));
  const upcomingService=new UpcomingService(db,config.PANDASCORE_API_TOKEN,options.pandascoreFetch,liveService);
  registerUpcoming(app,upcomingService);
  registerQuickForecast(app,new QuickForecastService(db,upcomingService,pagePredictions,undefined,optionalTier));
  registerSeriesReadiness(app,new SeriesReadinessService(db));
  const rosterCatalogue=new RosterCatalogueService(db,upcomingService,options.catalogueProvider??liveCatalogueProvider(config.DATABASE_URL));
  registerRosterCatalogue(app,rosterCatalogue);
  registerRosterContext(app,new RosterContextService(db,()=>rosterCatalogue.refreshRegistry()));
  registerLineupTemplates(app,new LineupTemplateRepository(db));
  registerTeamActivity(app,new TeamActivityRepository(db));
  registerScheduleTargets(app,freshScheduleTargets);
  registerTier1Scopes(app,new Tier1ScopeRepository(db));
  const history=new HistoryRefreshService(db,config.DATABASE_URL);
  app.addHook('onClose',async()=>history.close());
  registerHistoryRefresh(app,history);
  registerModelReadiness(app,new PredictionModelRegistry(db));
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден.', requestId: request.id } }));
  return app;
}
