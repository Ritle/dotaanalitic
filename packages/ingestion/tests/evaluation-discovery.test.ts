import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { EvaluationDiscoveryEntry, EvaluationDiscoveryScope } from '@dota/contracts';
import { OpenDotaClient } from '../src/opendota/client.js';
import { buildEvaluationDiscoveryLedger, collectEvaluationDiscovery, discoveryTraceStoppingReasons } from '../src/evaluation-discovery.js';

const now = '2026-11-02T12:00:00.000Z', from = '2026-11-02T00:00:00.000Z';
const scope: EvaluationDiscoveryScope = { schemaVersion: 1, kind: 'e1', planSha256: 'a'.repeat(64), planFingerprint: 'b'.repeat(64),
  windows: [{ fromAt: from, until: '2026-11-09T00:00:00.000Z', leagueId: null }], maxMaps: 5000, snapshotAt: '2026-11-10T00:00:00.000Z' };
const row = (id = '9007199254740993', start: number | null = Date.parse(from) / 1000) => ({
  match_id: id, start_time: start, leagueid: '77', series_id: '88', radiant_team_id: '11', dire_team_id: '22' });
function receipt(rows: unknown[], sequence = 0, endpoint = '/proMatches'): EvaluationDiscoveryEntry {
  const rawBody = JSON.stringify(rows);
  return { status: 'captured', sequence, endpoint, rawBody, fetchedAt: now,
    payloadSha256: createHash('sha256').update(rawBody).digest('hex') };
}
const ledger = (entries: EvaluationDiscoveryEntry[]) => buildEvaluationDiscoveryLedger(scope, entries, now, now, { maxProPages: 2, maxLeagues: 10 }, []);
function client(responses: unknown[], calls: string[] = []) {
  let index = 0;
  return new OpenDotaClient({ requestsPerMinute: 45, attempts: 1 }, { now: () => Date.parse(now), sleep: async () => {},
    fetch: async url => { calls.push(url.pathname + url.search); const value = responses[index++];
      if (value instanceof Response) return value; if (value instanceof Error) throw value;
      return new Response(JSON.stringify(value)); } });
}

it('projects only selection metadata regardless of winners, scores or malformed unused fields', () => {
  const one = ledger([receipt([{ ...row(), radiant_win: true, duration: 1, players: [] }])]);
  const two = ledger([receipt([{ ...row(), radiant_win: 'invalid', duration: 'ignored', players: 'ignored' }])]);
  expect(one.candidates).toEqual(two.candidates);
  expect(one).toMatchObject({ proEligibility: 'not_verified', metrics: null, deployable: false, summary: { uniqueMaps: 1, possibleTargetMaps: 1 } });
  expect(JSON.stringify(one.candidates)).not.toMatch(/radiant_win|duration|players/);
  expect(one.candidates[0]!.matchId).toBe('9007199254740993');
});

it('deduplicates observed IDs while preserving all receipt references, missing values and metadata conflicts', () => {
  const report = ledger([receipt([row(), { ...row('2'), series_id: null }, { ...row('3'), start_time: null }]),
    receipt([{ ...row(), radiant_team_id: '99' }], 1, '/leagues/77/matches')]);
  expect(report.summary).toMatchObject({ returnedRows: 4, uniqueMaps: 3, possibleTargetMaps: 3, uncertainMaps: 2 });
  const changed = report.candidates.find(c => c.matchId === row().match_id)!;
  expect(changed).toMatchObject({ disposition: 'metadata_conflict', reasons: ['CONFLICT_RADIANT_TEAM_ID'] });
  expect(changed.observations).toHaveLength(2);
  expect(report.candidates.find(c => c.matchId === '2')!.reasons).toContain('SERIES_UNKNOWN');
  expect(report.candidates.find(c => c.matchId === '3')!.disposition).toBe('scope_uncertain');
});

it('uses inclusive start/exclusive end and retains out-of-window siblings of target series', () => {
  const report = ledger([receipt([row('1'), row('2', Date.parse(scope.windows[0]!.until) / 1000),
    { ...row('3', Date.parse(from) / 1000 - 1), series_id: '99' }])]);
  expect(report.candidates.map(c => c.disposition)).toEqual(['pending_detail_verification', 'related_series_member', 'outside_scope']);
  expect(report.summary.possibleTargetMaps).toBe(1);
});

it('keeps league endpoint conflicts and missing league/time as unresolved rather than dropping them', () => {
  const v1 = { ...scope, kind: 'v1', windows: [{ ...scope.windows[0]!, leagueId: '77' }] };
  const report = buildEvaluationDiscoveryLedger(v1, [receipt([{ ...row('1'), leagueid: '99' },
    { ...row('2'), leagueid: null }, { ...row('3'), start_time: null }], 0, '/leagues/77/matches')], now, now, { maxProPages: 1, maxLeagues: 1 }, []);
  expect(report.candidates[0]!.reasons).toContain('LEAGUE_ENDPOINT_CONFLICT');
  expect(report.candidates[0]!.possibleTarget).toBe(true); // Cannot disappear from denominator via contradictory league metadata.
  expect(report.candidates[1]!.disposition).toBe('scope_uncertain');
  expect(report.candidates[2]!.disposition).toBe('scope_uncertain');
});

it('checks raw SHA, receipt sequence and source clocks; late snapshots cannot masquerade as original data', () => {
  const entry = receipt([row()]);
  expect(() => ledger([{ ...entry, rawBody: 'private-sentinel' }])).toThrow('discovery_payload_sha_mismatch');
  expect(() => ledger([{ ...entry, sequence: 1 }])).toThrow('discovery_entry_order_or_clock');
  const late = buildEvaluationDiscoveryLedger(scope, [], '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z', { maxProPages: 1, maxLeagues: 1 }, []);
  expect(late).toMatchObject({ status: 'partial', stoppingReasons: ['AFTER_EVALUATION_SNAPSHOT'] });
});

it('persists every response before pagination/league requests and sends exact bigint-safe cursor', async () => {
  const calls: string[] = [], persisted: EvaluationDiscoveryEntry[] = [];
  const source = client([[row()], [], [row(), { ...row('9'), series_id: null }]], calls);
  const result = await collectEvaluationDiscovery(scope, source, async e => { persisted.push(e); }, { maxProPages: 2, maxLeagues: 1 }, () => now);
  expect(calls).toEqual(['/api/proMatches', '/api/proMatches?less_than_match_id=9007199254740993', '/api/leagues/77/matches']);
  expect(persisted.map(e => e.sequence)).toEqual([0, 1, 2]);
  expect(result.ledger).toMatchObject({ status: 'discovered', remoteCompleteness: 'unknown', summary: { uniqueMaps: 2, possibleTargetMaps: 2 } });
});

it('records page budget and nonadvancing pagination as partial without dropping returned IDs', async () => {
  const limited = await collectEvaluationDiscovery(scope, client([[row()], [row()]]), async () => {}, { maxProPages: 1, maxLeagues: 1 }, () => now);
  expect(limited.ledger.stoppingReasons).toContain('PRO_PAGE_LIMIT');
  const stuck = await collectEvaluationDiscovery(scope, client([[row()], [row()], [row()]]), async () => {}, { maxProPages: 2, maxLeagues: 1 }, () => now);
  expect(stuck.ledger.stoppingReasons).toContain('PAGINATION_NOT_ADVANCING');
  expect(stuck.ledger.summary.returnedRows).toBe(3);
});

it('records HTTP failures and still retains discovered target candidates', async () => {
  const result = await collectEvaluationDiscovery(scope, client([[row()], [], new Response('', { status: 429, headers: { 'retry-after': '600' } })]),
    async () => {}, { maxProPages: 2, maxLeagues: 1 }, () => now);
  expect(result.ledger).toMatchObject({ status: 'partial', summary: { uniqueMaps: 1, sourceFailures: 1, pendingDetails: 1 } });
  expect(result.entries.at(-1)).toMatchObject({ status: 'failed', code: 'source_rate_limited' });
});

it('does not cherry-pick leagues when all observed target leagues exceed the budget', async () => {
  const calls: string[] = [];
  const result = await collectEvaluationDiscovery(scope, client([[row('1'), { ...row('2'), leagueid: '78' }], []], calls), async () => {},
    { maxProPages: 2, maxLeagues: 1 }, () => now);
  expect(result.ledger.stoppingReasons).toContain('LEAGUE_LIMIT');
  expect(calls).toHaveLength(2); expect(result.ledger.candidates).toHaveLength(2);
});

it('V1 requests only registered main-event leagues; future windows make no network request', async () => {
  const calls: string[] = [], v1: EvaluationDiscoveryScope = { ...scope, kind: 'v1', windows: [{ ...scope.windows[0]!, leagueId: '77' }] };
  const result = await collectEvaluationDiscovery(v1, client([[row()]], calls), async () => {}, { maxProPages: 1, maxLeagues: 1 }, () => now);
  expect(calls).toEqual(['/api/leagues/77/matches']); expect(result.ledger.summary.uniqueMaps).toBe(1);
  const future = { ...v1, windows: [{ ...v1.windows[0]!, fromAt: '2026-11-03T00:00:00.000Z' }] };
  const unopened = await collectEvaluationDiscovery(future, client([], calls), async () => {}, { maxProPages: 1, maxLeagues: 1 }, () => now);
  expect(unopened.ledger.status).toBe('not_started'); expect(calls).toHaveLength(1);
});

it('stops on durable receipt failure instead of hiding it as a provider error', async () => {
  const calls: string[] = [];
  await expect(collectEvaluationDiscovery(scope, client([[row()]], calls), async () => { throw Error('disk-full'); },
    { maxProPages: 1, maxLeagues: 1 }, () => now)).rejects.toThrow('disk-full');
  expect(calls).toHaveLength(1);
});

it('rejects invalid cursors before network access', async () => {
  const calls: string[] = [], source = client([], calls);
  expect(() => source.getProMatchDiscovery('not-a-number')).toThrow(); expect(calls).toHaveLength(0);
});

it('reconstructs required pages and league reads and refuses a dropped receipt', () => {
  const entries = [receipt([row()]), receipt([], 1, '?invalid')];
  expect(() => discoveryTraceStoppingReasons(scope, entries, { maxProPages: 2, maxLeagues: 1 }, now)).toThrow('discovery_request_trace_mismatch');
  const valid = [entries[0]!, receipt([], 1, '/proMatches?less_than_match_id=9007199254740993'), receipt([row()], 2, '/leagues/77/matches')];
  expect(discoveryTraceStoppingReasons(scope, valid, { maxProPages: 2, maxLeagues: 1 }, now)).toEqual([]);
  expect(() => discoveryTraceStoppingReasons(scope, valid.slice(0, 2), { maxProPages: 2, maxLeagues: 1 }, now)).toThrow('discovery_request_trace_mismatch');
});

it('keeps an over-limit inventory visible and partial without silent truncation', () => {
  const report = ledger([receipt(Array.from({ length: 5001 }, (_, i) => row(String(i + 1))))]);
  expect(report.candidates).toHaveLength(5001); expect(report.status).toBe('partial'); expect(report.stoppingReasons).toContain('INVENTORY_LIMIT');
});
