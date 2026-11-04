import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { V1ModelReadinessSchema } from '@dota/contracts';
import type { V1ModelRegistry } from '@dota/db';
export function registerModelReadiness(app: FastifyInstance, registry: V1ModelRegistry) {
  // Waiting registry locks must not consume the pool needed by prediction/history.
  let reading = false;
  app.get('/api/v1/models/readiness', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!z.object({}).strict().safeParse(req.query).success) return reply.code(400).send({ error: {
      code: 'VALIDATION_ERROR', requestId: req.id, message: 'Проверка модели не принимает параметры.' } });
    if (reading) return reply.header('Retry-After', '1').code(429).send({ error: {
      code: 'MODEL_CHECK_BUSY', requestId: req.id, message: 'Проверка модели уже выполняется. Повторите через секунду.' } });
    reading = true;
    try {
      const gate = await registry.readiness();
      return V1ModelReadinessSchema.parse({ stage: 'pre_match', checkedAt: new Date().toISOString(), status: gate.status,
        reason: 'reason' in gate ? gate.reason : null, modelId: gate.modelId,
        reportSha256: 'reportSha256' in gate ? gate.reportSha256 : null, teamAWinProbability: null });
    } finally { reading = false; }
  });
}
