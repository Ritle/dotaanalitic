import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import rateLimit from '@fastify/rate-limit';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AuthResponseSchema, LoginSchema } from '@dota/contracts';
import type { AppConfig } from '../../config.js';
import { AuthError, AuthService, SESSION_SECONDS, type Session } from './service.js';

declare module 'fastify' {
  interface FastifyRequest { ownerSession: Session | null }
}
export async function registerAuth(app: FastifyInstance, config: AppConfig, service: AuthService) {
  const secure = new URL(config.WEB_ORIGIN).protocol === 'https:';
  const sessionName = secure ? '__Host-session' : 'dota_session';
  const csrfName = secure ? '__Host-csrf' : 'dota_csrf';
  const secret = config.AUTH_COOKIE_SECRET ?? randomBytes(32).toString('base64url');
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
  await app.register(cookie, { secret });
  await app.register(csrf, {
    cookieKey: csrfName,
    cookieOpts: { ...cookieOptions, signed: true },
    getToken: request => typeof request.headers['x-csrf-token'] === 'string' ? request.headers['x-csrf-token'] : undefined,
    getUserInfo: request => request.ownerSession?.tokenHash ?? '',
    csrfOpts: { hmacKey: secret }
  });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  app.decorateRequest('ownerSession', null);

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (request.method === 'OPTIONS' || (request.method === 'GET' && path === '/health')) return;
    reply.header('Cache-Control', 'no-store');
    const login = request.method === 'POST' && path === '/api/v1/auth/login';
    if (!login) {
      request.ownerSession = await service.authenticate(request.cookies[sessionName]);
      if (!request.ownerSession) throw new AuthError('UNAUTHORIZED');
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      // Covers login CSRF too; no anonymous CSRF bootstrap endpoint is needed.
      if (request.headers.origin !== config.WEB_ORIGIN || request.headers['sec-fetch-site'] === 'cross-site') {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Недопустимый источник запроса.', requestId: request.id } });
      }
    }
  });
  app.addHook('onRequest', (request, reply, done) => {
    if (request.ownerSession && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      // Use the plugin's callback hook directly: rejected CSRF sends its own
      // response and does not call done; wrapping it in a Promise would hang.
      app.csrfProtection(request, reply, done);
    } else done();
  });

  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = LoginSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Проверьте логин и пароль.', requestId: request.id } });
    const session = await service.login(input.data.login, input.data.password, request.cookies[sessionName]);
    // Rotation prevents reusing a supplied/previous token as the new session.
    reply.setCookie(sessionName, session.token, { ...cookieOptions, maxAge: SESSION_SECONDS, expires: new Date(session.expiresAt) });
    const csrfToken = reply.generateCsrf({ userInfo: session.tokenHash });
    request.log.info({ event: 'owner_login_succeeded', request_id: request.id });
    return AuthResponseSchema.parse({ owner: session.owner, expiresAt: session.expiresAt, csrfToken });
  });
  app.get('/api/v1/auth/me', async (request, reply) => {
    const session = request.ownerSession!;
    return AuthResponseSchema.parse({ owner: session.owner, expiresAt: session.expiresAt,
      csrfToken: reply.generateCsrf({ userInfo: session.tokenHash }) });
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    await service.logout(request.ownerSession!);
    reply.clearCookie(sessionName, cookieOptions).clearCookie(csrfName, cookieOptions);
    request.log.info({ event: 'owner_logout_succeeded', request_id: request.id });
    return reply.code(204).send();
  });
}
