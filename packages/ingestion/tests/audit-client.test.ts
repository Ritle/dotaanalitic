import { expect, test } from 'vitest';
import { OpenDotaClient } from '../src/opendota/client.js';

test('league discovery validates identifiers and preserves bigint map IDs', async () => {
  const paths: string[] = [];
  const client = new OpenDotaClient({}, { fetch: async url => {
    paths.push(url.pathname);
    return new Response(JSON.stringify([{ match_id: '9007199254740993', leagueid: 77, start_time: 1700000000 }]));
  } });
  expect((await client.getLeagueMatches('77')).data[0]!.match_id).toBe('9007199254740993');
  expect(paths).toEqual(['/api/leagues/77/matches']);
  expect(() => client.getLeagueMatches('77/players')).toThrow();
  expect(client.requestsUsed).toBe(1);
});
test('all HTTP attempts count including recovered 429/503 and stats cannot be mutated by caller', async () => {
  let now = 0, n = 0; const observed: number[] = [];
  const client = new OpenDotaClient({ maxRequests: 3 }, { now: () => now, sleep: async ms => { now += ms; }, random: () => 0,
    budget: { beforeRequest: async () => {}, observe: async status => { observed.push(status); } },
    fetch: async () => {
      const status = [429,503,200][n++]!;
      return new Response(status === 200 ? '[]' : '', { status, headers: { 'retry-after': '0' } });
    } });
  expect((await client.getLeagueMatches('77')).source.attempts).toBe(3);
  expect(observed).toEqual([429,503,200]);
  expect(client.requestStats).toEqual({ attempts: 3, httpStatuses: { '429': 1, '503': 1, '200': 1 }, transportErrors: {} });
  client.requestStats.httpStatuses['200'] = 99;
  expect(client.requestStats.httpStatuses['200']).toBe(1);
});
test('recovered network failure is recorded without unsafe provider error text', async () => {
  let now = 0, n = 0;
  const client = new OpenDotaClient({}, { now: () => now, sleep: async ms => { now += ms; }, fetch: async () => {
    if (n++ === 0) throw new Error('Authorization: private-value');
    return new Response('[]');
  } });
  await client.getLeagueMatches('77');
  expect(client.requestStats).toEqual({ attempts: 2, httpStatuses: { '200': 1 }, transportErrors: { source_network_error: 1 } });
  expect(JSON.stringify(client.requestStats)).not.toContain('private-value');
});
