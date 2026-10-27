import Fastify from 'fastify';
import cors from '@fastify/cors';

export async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    credentials: true
  });
  app.get('/health', async () => ({ status: 'ok', service: 'dota2-pro-analytics-api' }));
  // Feature routes must only be added with authentication and validated contracts.
  // See docs/API_CONTRACTS.md and docs/IMPLEMENTATION_PLAN.md.
  return app;
}
