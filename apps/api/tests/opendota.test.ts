import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { OpenDotaClient, retryAfterMilliseconds } from '../src/providers/opendota/client.js';
import { MatchSchema, PlayerSchema, ProMatchesSchema, TeamSchema, TeamPlayersSchema } from '../src/providers/opendota/schemas.js';
import { describeMatch, fixtureSanitizer } from '../src/providers/opendota/spike.js';

const map = () => ({
  match_id: 123, start_time: 1700000000, radiant_win: false,
  radiant_team_id: 9, dire_team_id: 10, series_id: 0,
  players: [128, 0, 129, 1, 130, 2, 131, 3, 132, 4].map((slot, index) => ({
    player_slot: slot, account_id: 100001 + index, hero_id: index + 1, lane_role: null
  })),
  picks_bans: null
});
const json = (data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), init);
const fixtureEnvelope = z.object({ _fixture: z.object({ synthetic: z.literal(true), origin: z.literal('sanitized_live_shape') }), data: z.unknown() });
const fixture = (name: string) => fixtureEnvelope.parse(JSON.parse(readFileSync(
  new URL(`../../../tests/fixtures/opendota/provider-spike/${name}.json`, import.meta.url), 'utf8')));
function setup(responses: (Response | Error)[], options: ConstructorParameters<typeof OpenDotaClient>[0] = {}) {
  let now = Date.UTC(2026, 9, 30);
  const started: number[] = [];
  const fetcher = vi.fn(async (_url: URL, _init: RequestInit) => {
    started.push(now);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('unexpected test request');
    return next;
  });
  const sleep = vi.fn(async (ms: number) => { now += ms; });
  const client = new OpenDotaClient(options, { fetch: fetcher, now: () => now, sleep, random: () => 0 });
  return { client, fetcher, sleep, started };
}

describe('OpenDota validated boundary', () => {
  const cases: [string, z.ZodType][] = [
    ['discovery', ProMatchesSchema], ['match-1', MatchSchema], ['match-2', MatchSchema],
    ['team-roster', z.object({ teamProfile: TeamSchema, roster: TeamPlayersSchema })], ['player', PlayerSchema]
  ];
  test.each(cases)('sanitized live-shape fixture %s passes the consumed-field schema', (name, schema) => {
    expect(schema.safeParse(fixture(name).data).success).toBe(true);
  });
  test('real-shape missing organizations/series do not discard final heroes; twelve raw picks remain twelve', () => {
    const partial = MatchSchema.parse(fixture('match-1').data);
    expect(describeMatch(partial)).toMatchObject({ teamsPresent: false, seriesId: null, finalHeroes10: true });
    const outlier = MatchSchema.parse(fixture('match-2').data);
    expect(describeMatch(outlier)).toMatchObject({ rawPickEvents: 12, finalHeroes10: true, draftOrderValid: null });
  });
  test('current membership flags do not force exactly five historical or hypothetical participants', () => {
    const members = TeamPlayersSchema.parse(Array.from({ length: 6 }, (_, index) => ({ account_id: index + 1, is_current_team_member: true })));
    expect(members).toHaveLength(6);
    expect(members.every(member => !('role_pos' in member))).toBe(true);
  });
  test('keeps IDs as decimal strings and preserves false outcome, nullable fields and source evidence', async () => {
    const raw = JSON.stringify(map());
    const { client } = setup([new Response(raw, { headers: { 'x-rate-limit-remaining-minute': '42' } })]);
    const result = await client.getMatch('123');
    expect(result.data).toMatchObject({ match_id: '123', radiant_win: false, series_id: null, picks_bans: null });
    expect(result.data.players?.[0]?.account_id).toBe('100001');
    expect(result.rawBody).toBe(raw);
    expect(result.source).toMatchObject({ endpoint: '/matches/123', knownAt: null,
      payloadSha256: createHash('sha256').update(raw).digest('hex'), rateLimitRemaining: { minute: 42, day: null, month: null } });
    expect(describeMatch(result.data)).toMatchObject({ slotsValid: true, finalHeroes10: true, accountIds10: true,
      draftOrderValid: null, firstPickSide: null, lineupKnownBeforeStart: null, proClassification: 'unverified' });
  });
  test('accepts BIGINT strings and rejects rounded/unsafe numeric identifiers', () => {
    expect(MatchSchema.parse({ match_id: '9007199254740993' }).match_id).toBe('9007199254740993');
    expect(MatchSchema.safeParse({ match_id: 9007199254740992 }).success).toBe(false);
    expect(MatchSchema.safeParse({ match_id: '9223372036854775808' }).success).toBe(false);
    expect(MatchSchema.safeParse({ match_id: '001' }).success).toBe(false);
    expect(MatchSchema.safeParse({ match_id: '1', players: [{ account_id: 4294967296 }] }).success).toBe(false);
  });
  test('missing account/profile, heroes and draft remain unknown rather than invented', () => {
    const partial = MatchSchema.parse({ match_id: 1, players: [{ account_id: 0, hero_id: 0 }], picks_bans: [] });
    expect(partial.players?.[0]?.account_id).toBeNull();
    expect(PlayerSchema.parse({ profile: null }).profile).toBeNull();
    expect(describeMatch(partial)).toMatchObject({ finalHeroes10: false, accountIds10: false,
      eventAt: null, rawDraftEvents: 0, rawPickEvents: 0, verifiedRoles: null });
    expect(describeMatch(MatchSchema.parse({ match_id: 2 }))).toMatchObject({ rawDraftEvents: null, rawPickEvents: null });
  });
  test.each([0, 11, 12])('preserves %i raw picks, source order and unknown provider action fields', async count => {
    const actions = Array.from({ length: count }, (_, index) => ({
      is_pick: true, hero_id: index + 1, order: count - index, team: index % 2, extra_provider_field: { marker: index }
    }));
    const payload = { ...map(), picks_bans: actions };
    const before = structuredClone(payload);
    const { client } = setup([json(payload)]);
    const result = await client.getMatch('123');
    expect(result.data.picks_bans).toEqual(actions);
    expect(JSON.parse(result.rawBody).picks_bans).toEqual(actions);
    expect(payload).toEqual(before);
    expect(describeMatch(result.data)).toMatchObject({ finalHeroes10: true, rawPickEvents: count, draftOrderValid: null });
  });
  test('duplicate slots/accounts/heroes cannot become a complete lineup', () => {
    const payload = map();
    payload.players[1] = { player_slot: 128, account_id: 100001, hero_id: 1, lane_role: null };
    expect(describeMatch(MatchSchema.parse(payload))).toMatchObject({ slotsValid: false, finalHeroes10: false, accountIds10: false });
  });
  test('unknown native side values and roles stay unverified', () => {
    const payload = map();
    payload.players[0] = { player_slot: 127, account_id: 100001, hero_id: 1, lane_role: null };
    expect(describeMatch(MatchSchema.parse(payload))).toMatchObject({ slotsValid: false, verifiedRoles: null, firstPickSide: null });
  });
  test('mismatched map/team/profile identities fail instead of being relabelled', async () => {
    const { client } = setup([json({ match_id: 2 }), json({ team_id: 2 }), json({ profile: { account_id: 2 } })]);
    await expect(client.getMatch('1')).rejects.toMatchObject({ code: 'source_id_mismatch' });
    await expect(client.getTeam('1')).rejects.toMatchObject({ code: 'source_id_mismatch' });
    await expect(client.getPlayer('1')).rejects.toMatchObject({ code: 'source_id_mismatch' });
  });
  test('invalid shapes return bounded field paths without provider payload text', async () => {
    const { client } = setup([json({ match_id: 123, players: 'sensitive-provider-body' })]);
    await expect(client.getMatch('123')).rejects.toMatchObject({ code: 'source_schema_invalid', fields: ['players'] });
    expect(client.requestsUsed).toBe(1);
  });
  test('sanitized fixture projections remap identifiers consistently and remove personal text', () => {
    const sanitize = fixtureSanitizer();
    const fixture = sanitize({ ...map(), personaname: 'private-name', start_time: 1,
      picks_bans: [{ is_pick: true, hero_id: 1, team: 0, order: 0, private_text: 'not-for-fixture' }] });
    const text = JSON.stringify(fixture);
    expect(fixture._fixture.synthetic).toBe(true);
    expect(text).not.toContain('private-name');
    expect(text).not.toContain('not-for-fixture');
    expect(text).not.toContain('"match_id":"123"');
    expect(sanitize({ match_id: '123' }).data).toEqual({ match_id: '900000000001' });
  });
});

describe('OpenDota bounded HTTP transport', () => {
  test('serializes parallel calls and paces all attempts', async () => {
    const { client, fetcher, started } = setup([json([]), json([]), json([])]);
    await Promise.all([client.getProMatches(), client.getProMatches(), client.getProMatches()]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(1334);
    expect(started[2]! - started[1]!).toBeGreaterThanOrEqual(1334);
  });
  test('low configured RPM can wait a full minute without treating local pacing as HTTP 429', async () => {
    const { client, started } = setup([json([]), json([])], { requestsPerMinute: 1 });
    await client.getProMatches(); await client.getProMatches();
    expect(started[1]! - started[0]!).toBe(60000);
  });
  test('429 honors Retry-After seconds; 503 honors HTTP date', async () => {
    const { client, started } = setup([new Response('', { status: 429, headers: { 'retry-after': '2' } }), json([])]);
    expect((await client.getProMatches()).source.attempts).toBe(2);
    expect(started[1]! - started[0]!).toBe(2000);
    const date = new Date(Date.UTC(2026, 9, 30) + 6000).toUTCString();
    const server = setup([new Response('', { status: 503, headers: { 'retry-after': date } }), json([])]);
    await server.client.getProMatches();
    expect(server.started[1]! - server.started[0]!).toBe(6000);
  });
  test('long Retry-After is reported without retrying early, including the next queued call', async () => {
    const { client, fetcher } = setup([new Response('', { status: 429, headers: { 'retry-after': '120' } })]);
    await expect(client.getProMatches()).rejects.toMatchObject({ code: 'source_rate_limited', retryAfterMs: 120000 });
    await expect(client.getProMatches()).rejects.toMatchObject({ code: 'source_rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test('404 is not retried and attempt budget includes failed HTTP calls', async () => {
    const missing = setup([new Response('do not echo this', { status: 404 })]);
    await expect(missing.client.getPlayer('1')).rejects.toMatchObject({ code: 'source_http_error', status: 404 });
    expect(missing.fetcher).toHaveBeenCalledTimes(1);
    const budget = setup([new Response('', { status: 500 })], { maxRequests: 1 });
    await expect(budget.client.getProMatches()).rejects.toMatchObject({ code: 'request_budget_exhausted' });
    expect(budget.fetcher).toHaveBeenCalledTimes(1);
  });
  test('network failures retry finitely without leaking URLs, keys or raw errors', async () => {
    const { client, fetcher } = setup(Array.from({ length: 3 }, () => new Error('https://private/?api_key=test-secret')),
      { apiKey: 'test-secret' });
    await expect(client.getProMatches()).rejects.toMatchObject({ code: 'source_network_error', message: 'Источник OpenDota недоступен: source_network_error' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url.href).toBe('https://api.opendota.com/api/proMatches');
      expect(init.redirect).toBe('error');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-secret' });
    }
  });
  test('timeouts abort the request and have a stable error code', async () => {
    const fetcher = vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('private network details')));
    }));
    const client = new OpenDotaClient({ attempts: 1, timeoutMs: 5 }, { fetch: fetcher });
    await expect(client.getProMatches()).rejects.toMatchObject({ code: 'source_timeout' });
  });
  test('oversized bodies and invalid JSON are not retried', async () => {
    const large = setup([json({ match_id: 123 })], { maxResponseBytes: 4 });
    await expect(large.client.getMatch('123')).rejects.toMatchObject({ code: 'source_response_too_large' });
    const invalid = setup([new Response('not JSON with sensitive text')]);
    await expect(invalid.client.getProMatches()).rejects.toMatchObject({ code: 'source_invalid_json' });
    expect(invalid.fetcher).toHaveBeenCalledTimes(1);
  });
  test('fixed provider host and numeric-only endpoint arguments prevent arbitrary fetches', async () => {
    expect(() => new OpenDotaClient({ baseUrl: 'https://other.example/api' })).toThrow();
    expect(() => new OpenDotaClient({ baseUrl: 'https://api.opendota.com/api?api_key=secret' })).toThrow();
    const { client, fetcher } = setup([]);
    await expect(client.getMatch('../players/1')).rejects.toMatchObject({ code: 'invalid_id' });
    await expect(client.getPlayer('4294967296')).rejects.toMatchObject({ code: 'invalid_id' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  test('Retry-After malformed, past, seconds and date variants', () => {
    expect(retryAfterMilliseconds(null, 0)).toBeNull();
    expect(retryAfterMilliseconds('-1', 0)).toBeNull();
    expect(retryAfterMilliseconds('1.5', 0)).toBeNull();
    expect(retryAfterMilliseconds('invalid', 0)).toBeNull();
    expect(retryAfterMilliseconds('10', 0)).toBe(10000);
    expect(retryAfterMilliseconds('Thu, 01 Jan 1970 00:00:01 GMT', 2000)).toBe(0);
  });
});
