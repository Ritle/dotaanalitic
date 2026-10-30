import { expect, test } from 'vitest';
import { readConfig } from '../src/config.js';

test('configuration has local defaults and parses environment overrides', () => {
  expect(readConfig({})).toEqual({ API_PORT: 3000, API_HOST: '127.0.0.1', WEB_ORIGIN: 'http://localhost:5173' });
  expect(readConfig({ API_PORT: '3001', API_HOST: '127.0.0.2', WEB_ORIGIN: 'http://localhost:5174' }))
    .toEqual({ API_PORT: 3001, API_HOST: '127.0.0.2', WEB_ORIGIN: 'http://localhost:5174' });
});

test.each(['', '0', '-1', '65536', '1.5', 'invalid'])('rejects invalid API_PORT %j', API_PORT => {
  expect(() => readConfig({ API_PORT })).toThrow('Некорректная конфигурация: API_PORT');
});

test('configuration errors identify fields without disclosing environment values', () => {
  expect(() => readConfig({ WEB_ORIGIN: 'secret-origin', OPENDOTA_API_KEY: 'private-key' }))
    .toThrow(/^Некорректная конфигурация: WEB_ORIGIN$/);
});
