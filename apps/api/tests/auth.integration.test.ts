import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '@dota/db';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { AuthService, tokenHash } from '../src/modules/auth/service.js';
import { AuthResponseSchema } from '@dota/contracts';

let database: Awaited<ReturnType<typeof testDatabase>>;
let app: FastifyInstance;
let password: string;
const origin = 'http://localhost:5173';
const cookies = (headers: string | string[] | undefined) => (Array.isArray(headers) ? headers : [headers ?? '']).map(value => value.split(';')[0]).join('; ');
const payload = () => ({ login: 'synthetic-owner', password });
function ownerCli(command: 'create' | 'reset') {
  return execFileSync(process.execPath, [
    fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('../src/modules/auth/owner-cli.ts', import.meta.url)),
    command, '--login', 'synthetic-owner', '--password-stdin'
  ], { env: { ...process.env, DATABASE_URL: database.url }, input: password+'\n', encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
}
const login = (server = app, extra: Record<string,string> = {}) => server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin, ...extra }, payload: payload() });
beforeAll(async () => {
  database = await testDatabase();
  password = 'Синтетика🔒' + randomBytes(24).toString('base64url');
  expect(JSON.parse(ownerCli('create'))).toEqual({status:'owner_created'});
}, 30000);
beforeEach(async () => {
  await sql`DELETE FROM auth_login_budget`.execute(database.db);
  await sql`DELETE FROM auth_sessions`.execute(database.db);
  await sql`UPDATE app_users SET is_active=TRUE`.execute(database.db);
  app = await buildApp(readConfig({ DATABASE_URL: database.url }), { db: database.db, logger: false });
  app.get('/api/v1/private-probe', async () => ({ private: true }));
});
afterEach(async () => { await app?.close(); });
afterAll(async () => { await database?.close(); });

test('only health/login are public; default guard covers future routes and no signup', async () => {
  expect((await app.inject('/health')).statusCode).toBe(200);
  expect((await app.inject('/api/v1/auth/me')).statusCode).toBe(401);
  expect((await app.inject('/api/v1/private-probe')).statusCode).toBe(401);
  expect((await app.inject({ method:'POST',url:'/api/v1/auth/register',payload:payload() })).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/api/v1/auth/logout'})).statusCode).toBe(401);
  const preflight = await app.inject({method:'OPTIONS',url:'/api/v1/auth/login',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}});
  expect(preflight.statusCode).toBe(204);
});
test('login stores Argon2id/hash only, sets cookie, restores and revokes on logout', async () => {
  const response = await login();
  expect(response.statusCode).toBe(200);
  const result = AuthResponseSchema.parse(response.json());
  expect(result.owner.login).toBe('synthetic-owner');
  expect(response.headers['cache-control']).toBe('no-store');
  const header = cookies(response.headers['set-cookie']);
  expect(response.headers['set-cookie']?.toString()).toContain('HttpOnly');
  expect(response.headers['set-cookie']?.toString()).toContain('SameSite=Lax');
  const token = /dota_session=([^;]+)/.exec(header)![1]!;
  const stored = await sql<{password_hash:string;token_hash:string}>`SELECT u.password_hash,s.token_hash FROM app_users u JOIN auth_sessions s ON s.user_id=u.id`.execute(database.db);
  expect(stored.rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
  expect(stored.rows[0]!.password_hash).not.toContain(password);
  expect(stored.rows[0]!.token_hash).toBe(tokenHash(token));
  expect(JSON.stringify(response.json())).not.toContain(token);
  const me = await app.inject({url:'/api/v1/auth/me',headers:{cookie:header}});
  expect(me.statusCode).toBe(200);
  expect((await app.inject({url:'/api/v1/private-probe',headers:{cookie:header}})).statusCode).toBe(200);
  const logout = await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{origin,cookie:header,'x-csrf-token':result.csrfToken}});
  expect(logout.statusCode).toBe(204);
  expect(logout.headers['set-cookie']?.toString()).toContain('Max-Age=0');
  expect((await app.inject({url:'/api/v1/auth/me',headers:{cookie:header}})).statusCode).toBe(401);
});
test('malformed input, wrong credentials and unknown owner do not create sessions', async () => {
  expect((await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{...payload(),isAdmin:true}})).statusCode).toBe(400);
  const wrong = await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{...payload(),password:'wrong'}});
  const unknown = await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{...payload(),login:'unknown-owner'}});
  expect(wrong.statusCode).toBe(401);
  expect(wrong.json().error.message).toBe(unknown.json().error.message);
  expect(wrong.headers['set-cookie']).toBeUndefined();
  expect((await sql<{n:string}>`SELECT count(*)::text AS n FROM auth_sessions`.execute(database.db)).rows[0]!.n).toBe('0');
});
test('CSRF rejects missing, wrong and different-session tokens and untrusted origins', async () => {
  const first = await login();
  const second = await login();
  const cookie = cookies(first.headers['set-cookie']);
  for (const headers of [
    {origin,cookie},
    {origin,cookie,'x-csrf-token':'incorrect'},
    {origin,cookie,'x-csrf-token':second.json().csrfToken},
    {origin:'https://evil.example',cookie,'x-csrf-token':first.json().csrfToken},
    {cookie,'x-csrf-token':first.json().csrfToken}
  ]) expect((await app.inject({method:'POST',url:'/api/v1/auth/logout',headers})).statusCode).toBe(403);
  expect((await login(app,{origin:'https://evil.example'})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:payload()})).statusCode).toBe(403);
  expect((await app.inject({url:'/api/v1/auth/me',headers:{cookie}})).statusCode).toBe(200);
});
test('expired, revoked, malformed and inactive sessions fail closed', async () => {
  const response = await login();
  const cookie = cookies(response.headers['set-cookie']);
  await sql`UPDATE auth_sessions SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day'`.execute(database.db);
  expect((await app.inject({url:'/api/v1/auth/me',headers:{cookie}})).statusCode).toBe(401);
  expect((await app.inject({url:'/api/v1/auth/me',headers:{cookie:'dota_session=bad'}})).statusCode).toBe(401);
  const next = await login();
  await sql`UPDATE app_users SET is_active=FALSE`.execute(database.db);
  expect((await app.inject({url:'/api/v1/auth/me',headers:{cookie:cookies(next.headers['set-cookie'])}})).statusCode).toBe(401);
  expect((await login()).statusCode).toBe(401);
});
test('repeat login rotates token and does not accept the previous session', async () => {
  const first = await login();
  const previous = cookies(first.headers['set-cookie']);
  const second = await login(app,{cookie:previous});
  expect(second.statusCode).toBe(200);
  expect(cookies(second.headers['set-cookie'])).not.toBe(previous);
  expect((await app.inject({url:'/api/v1/auth/me',headers:{cookie:previous}})).statusCode).toBe(401);
});
test('HTTPS production cookies use host prefix, Secure, HttpOnly and no Domain', async () => {
  const production = await buildApp(readConfig({DATABASE_URL:database.url,NODE_ENV:'production',WEB_ORIGIN:'https://example.test',AUTH_COOKIE_SECRET:randomBytes(32).toString('hex')}),{db:database.db,logger:false});
  try {
    const result = await login(production,{origin:'https://example.test'});
    expect(result.statusCode).toBe(200);
    expect(result.headers['set-cookie']?.toString()).toContain('__Host-session=');
    expect(result.headers['set-cookie']?.toString()).toContain('Secure');
    expect(result.headers['set-cookie']?.toString()).not.toContain('Domain=');
  } finally { await production.close(); }
});
test('per-IP login throttling cannot be bypassed by spoofing forwarded headers', async () => {
  for (let i=0;i<5;i++) expect((await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin,'x-forwarded-for':'192.0.2.'+i},payload:{...payload(),password:'wrong'}})).statusCode).toBe(401);
  const blocked = await login(app,{'x-forwarded-for':'192.0.2.99'});
  expect(blocked.statusCode).toBe(429);
  expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
});
test('global attempt budget is atomic, persists across app restart and resets after deadline', async () => {
  const service = new AuthService(database.db);
  const attempts = await Promise.allSettled(Array.from({length:12},()=>service.reserveLoginAttempt()));
  expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(10);
  await app.close();
  app = await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const blocked = await login();
  expect(blocked.statusCode).toBe(429);
  expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  await sql`UPDATE auth_login_budget SET window_started_at=now()-interval '16 minutes'`.execute(database.db);
  expect((await login()).statusCode).toBe(200);
});
test('single-owner constraint rejects another account; CLI reset revokes every session', async () => {
  const previous = await login();
  const service = new AuthService(database.db);
  await expect(service.provision('second-owner',password)).rejects.toMatchObject({code:'OWNER_EXISTS'});
  await expect(sql`INSERT INTO app_users(login,password_hash) VALUES ('direct-second-owner',repeat('x',64))`.execute(database.db)).rejects.toMatchObject({code:'23505'});
  const output = ownerCli('reset');
  expect(output).not.toContain(password);
  expect(JSON.parse(output)).toEqual({status:'password_reset_sessions_revoked'});
  expect((await app.inject({url:'/api/v1/auth/me',headers:{cookie:cookies(previous.headers['set-cookie'])}})).statusCode).toBe(401);
});

test('logs and error responses omit passwords, cookies, CSRF and query input', async () => {
  let logs = '';
  const stream = new Writable({write(chunk, _encoding, callback) { logs += String(chunk); callback(); }});
  const server = await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:{stream}});
  server.get('/api/v1/error-probe', async () => { throw new Error('synthetic-internal-secret:'+password); });
  try {
    const result = await login(server);
    const cookie = cookies(result.headers['set-cookie']);
    const csrfToken = result.json().csrfToken as string;
    await server.inject({url:'/api/v1/auth/me?private_query=synthetic-private-value',headers:{cookie,authorization:'Bearer synthetic-private-bearer'}});
    const failed = await server.inject({url:'/api/v1/error-probe',headers:{cookie}});
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain(password);
    expect(failed.json().error.code).toBe('INTERNAL_ERROR');
    await server.inject({method:'POST',url:'/api/v1/auth/logout',headers:{origin,cookie,'x-csrf-token':csrfToken}});
    for (const value of [password,cookie,csrfToken,'synthetic-private-value','synthetic-private-bearer']) expect(logs).not.toContain(value);
    expect(logs).toContain('owner_login_succeeded');
    expect(logs).toContain('owner_logout_succeeded');
  } finally { await server.close(); }
});
