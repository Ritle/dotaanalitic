import { expect, test } from 'vitest';
import { readConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/test' };
test('configuration has local defaults and parses environment overrides', () => {
  expect(readConfig(base)).toMatchObject({ NODE_ENV: 'development', API_PORT: 3000, API_HOST: '127.0.0.1', WEB_ORIGIN: 'http://localhost:5173' });
  expect(readConfig({ ...base, API_PORT: '3001', WEB_ORIGIN: 'http://localhost:5174/' }))
    .toMatchObject({ API_PORT: 3001, WEB_ORIGIN: 'http://localhost:5174' });
});
test.each(['', '0', '-1', '65536', '1.5', 'invalid'])('rejects invalid API_PORT %j', API_PORT => {
  expect(() => readConfig({ ...base, API_PORT })).toThrow('Некорректная конфигурация: API_PORT');
});
test('configuration errors identify fields without disclosing environment values', () => {
  expect(() => readConfig({ ...base, WEB_ORIGIN: 'secret-origin', OPENDOTA_API_KEY: 'private-key' }))
    .toThrow(/^Некорректная конфигурация: WEB_ORIGIN$/);
});
test('production requires HTTPS and persistent signing secret', () => {
  expect(() => readConfig({ ...base, NODE_ENV: 'production' })).toThrow();
  expect(() => readConfig({ ...base, WEB_ORIGIN: 'http://192.0.2.1' })).toThrow();
  expect(() => readConfig({ ...base, WEB_ORIGIN: 'https://example.test/path' })).toThrow();
  expect(() => readConfig({ ...base, WEB_ORIGIN: 'https://user:pass@example.test' })).toThrow();
  expect(readConfig({ ...base, NODE_ENV: 'production', WEB_ORIGIN: 'https://example.test', AUTH_COOKIE_SECRET: 'synthetic-signing-secret-with-32-bytes' }).WEB_ORIGIN).toBe('https://example.test');
});
test('schedule credential is optional, server-only and never echoed by validation errors',()=>{
  expect(readConfig({...base,PANDASCORE_API_TOKEN:''}).PANDASCORE_API_TOKEN).toBeUndefined();
  expect(readConfig({...base,PANDASCORE_API_TOKEN:'synthetic-token'}).PANDASCORE_API_TOKEN).toBe('synthetic-token');
  expect(()=>readConfig({...base,PANDASCORE_API_TOKEN:'private\nsecret'})).toThrow(/^Некорректная конфигурация: PANDASCORE_API_TOKEN$/);
});
