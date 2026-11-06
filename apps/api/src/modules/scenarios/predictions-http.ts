import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { V1PredictionCreateSchema, V1PredictionViewSchema, V1PredictionHistorySchema } from '@dota/contracts';
import { ScenarioError, type V1PredictionService } from '@dota/db';
const Params = z.object({ id: z.uuid() }).strict(), Saved = Params.extend({ requestId: z.uuid() });
const Paging = z.object({ offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict();
export function registerPredictions(app: FastifyInstance, service: Pick<V1PredictionService,'create'|'get'|'history'>) {
  function failure(reply: FastifyReply, requestId: string, code: string) {
    return reply.code(code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' || code === 'REQUEST_CONFLICT' ? 409 : 400)
      .send({ error: { code, requestId, message: code === 'NOT_FOUND' ? 'Сценарий или расчёт не найден.' : code === 'REQUEST_CONFLICT' ?
        'Этот запрос уже сохранён с другими параметрами. Для нового расчёта нужен новый запрос.' : code === 'CONFLICT' ?
        'Сценарий изменён. Обновите сохранённую редакцию перед новым расчётом.' : 'Проверьте редакцию сценария и сведения о турнире.' } });
  }
  function handle(reply: FastifyReply, requestId: string, error: unknown) {
    if (error instanceof Error && error.message === 'runtime_request_busy') return reply.header('Retry-After', '1').code(429)
      .send({ error: { code: 'CALCULATION_BUSY', requestId, message: 'Другой расчёт ещё выполняется. Повторите запрос после его завершения.' } });
    if (error instanceof ScenarioError) return failure(reply, requestId, error.code);
    if (error instanceof Error && error.message === 'runtime_request_conflict') return failure(reply, requestId, 'REQUEST_CONFLICT');
    throw error;
  }
  app.post('/api/v1/scenarios/:id/predictions', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = Params.safeParse(req.params), body = V1PredictionCreateSchema.safeParse(req.body);
    if (!p.success || !body.success) return failure(reply, req.id, 'VALIDATION_ERROR');
    try { return V1PredictionViewSchema.parse(await service.create(req.ownerSession!.owner.id, { ...body.data, scenarioId: p.data.id })); }
    catch (error) { return handle(reply, req.id, error); }
  });
  app.get('/api/v1/scenarios/:id/predictions', async (req, reply) => {
    const p = Params.safeParse(req.params), q = Paging.safeParse(req.query);
    if (!p.success || !q.success) return failure(reply, req.id, 'VALIDATION_ERROR');
    try { return V1PredictionHistorySchema.parse(await service.history(req.ownerSession!.owner.id, p.data.id, q.data.offset)); }
    catch (error) { return handle(reply, req.id, error); }
  });
  app.get('/api/v1/scenarios/:id/predictions/:requestId', async (req, reply) => {
    const p = Saved.safeParse(req.params);
    if (!p.success) return failure(reply, req.id, 'VALIDATION_ERROR');
    try { return V1PredictionViewSchema.parse(await service.get(req.ownerSession!.owner.id, p.data.id, p.data.requestId)); }
    catch (error) { return handle(reply, req.id, error); }
  });
}
