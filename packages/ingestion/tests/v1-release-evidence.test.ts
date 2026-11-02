import { expect, it } from 'vitest';
import { prepareV1ReleaseEvidence, freezeV1ReleaseCapture, verifyV1ReleaseCapture } from '../src/v1-release-evidence.js';
import { freezeV1ReleaseInventory as freeze, prepareReleaseHistory } from '../../db/src/v1-release-inventory.js';
import { buildEvaluationDiscoveryLedger } from '../src/evaluation-discovery.js';
import { validateEvaluationDetails } from '../src/evaluation-details.js';
import { releaseEvidenceFixture, releaseSha, reseal } from './v1-release-evidence-fixtures.js';
const prepare = (f: ReturnType<typeof releaseEvidenceFixture>) => prepareV1ReleaseEvidence(f.plan, f.candidate, f.inventory, f.ledger, f.batches);
const freezeV1ReleaseInventory = (inventory: ReturnType<typeof freeze>) => {
  const { fingerprint: _old, ...body } = inventory;
  return freeze(body);
};
it('binds verified sources, retains broad pro history, and prepares features without scoring', () => {
  const f = releaseEvidenceFixture(), result = prepare(f);
  expect(result.coverage).toMatchObject({ observedTargetMaps: 2, dataReadyMaps: 2, mapCoverage: 1, observedKnownSeries: 2 });
  expect(result.rows.find(r => r.matchId === '201')).toMatchObject({ teamASide: 'radiant', reasons: [], historyCoverage: { minimumPlayerMaps: 6 } });
  expect(result.rows.find(r => r.matchId === '202')!.historyCoverage!.minimumPlayerMaps).toBe(7);
  expect(result.metrics).toBeNull(); expect(result.releaseGatePassed).toBe(false); expect(result.deployable).toBe(false);
  expect(result.remoteCompleteness).toBe('unknown'); expect(result.discoveryStatus).toBe('discovered');
});
it('preserves earlier feature history when a later sibling has an ineligible label', () => {
  const f = releaseEvidenceFixture();
  const first = f.inventory.source.candidates.find(m => m.matchId === '201')!;
  const later = f.inventory.source.candidates.find(m => m.matchId === '202')!;
  // Canonical linkage declares them one series; mismatched later detail excludes the target series.
  later.seriesId = first.seriesId; if (later.outcome.status === 'verified') later.outcome.seriesId = first.seriesId;
  f.inventory = freezeV1ReleaseInventory(f.inventory);
  const before = prepare(f), firstCoverage = before.rows.find(r => r.matchId === '201')!.historyCoverage;
  later.outcome = { status: 'unavailable', matchId: '202', reasons: ['UNVERIFIED'] };
  // Modify the normalized inventory, not the already detached original row.
  f.inventory.source.candidates.find(m => m.matchId === '202')!.outcome = later.outcome;
  f.inventory = freezeV1ReleaseInventory(f.inventory);
  const after = prepare(f);
  expect(after.rows.find(r => r.matchId === '201')!.historyCoverage).toEqual(firstCoverage);
  expect(after.coverage.dataReadyMaps).toBe(0);
  expect(prepareReleaseHistory(f.inventory).history.maps.some(m => m.matchId === '201')).toBe(true);
});
it('missing imported targets stay in the denominator', () => {
  const f = releaseEvidenceFixture(); f.inventory.source.candidates = f.inventory.source.candidates.filter(m => m.matchId !== '201');
  f.inventory.metadata = f.inventory.metadata.filter(m => m.matchId !== '201'); f.inventory = freezeV1ReleaseInventory(f.inventory);
  const result = prepare(f); expect(result.coverage.observedTargetMaps).toBe(2); expect(result.coverage.dataReadyMaps).toBe(1);
  expect(result.rows.find(r => r.matchId === '201')!.reasons).toContain('CANONICAL_MAP_MISSING');
});
it('refuses to omit any reviewed development map from the frozen local inventory', () => {
  const f = releaseEvidenceFixture(); f.inventory.source.candidates.shift(); f.inventory.metadata.shift();
  f.inventory = freezeV1ReleaseInventory(f.inventory); expect(() => prepare(f)).toThrow('release_reviewed_history_missing');
});
it('treats undiscovered local target and unknown local league as possible targets, not invisible rows', () => {
  const f = releaseEvidenceFixture();
  const map = structuredClone(f.inventory.source.candidates.find(m => m.matchId === '201')!); map.matchId = '203';
  if (map.outcome.status === 'verified') map.outcome.matchId = '203';
  f.inventory.source.candidates.push(map); f.inventory.metadata.push({ matchId: '203', leagueId: null,
    radiantProviderTeamId: '111', direProviderTeamId: '222' }); f.inventory = freezeV1ReleaseInventory(f.inventory);
  const result = prepare(f); expect(result.coverage.observedTargetMaps).toBe(3);
  expect(result.rows.find(r => r.matchId === '203')!.reasons).toContain('LOCAL_TARGET_UNDISCOVERED');
  expect(result.rows.find(r => r.matchId === '201')!.reasons).toContain('SERIES_MEMBER_EXCLUDED');
});
it('a warmup sibling vetoes test-series selection without removing its earlier Elo history', () => {
  const f = releaseEvidenceFixture(), warmup = f.inventory.source.candidates[0]!;
  const target = f.inventory.source.candidates.find(m => m.matchId === '201')!;
  target.seriesId = warmup.seriesId; if (target.outcome.status === 'verified') target.outcome.seriesId = warmup.seriesId;
  f.inventory = freezeV1ReleaseInventory(f.inventory);
  const result = prepare(f), row = result.rows.find(r => r.matchId === '201')!;
  expect(row.historyCoverage!.minimumPlayerMaps).toBe(6); expect(row.reasons).toContain('SERIES_MEMBER_EXCLUDED');
  expect(prepareReleaseHistory(f.inventory).history.maps).toHaveLength(8);
});
it('detects a forged canonical outcome even with a self-consistent inventory hash and unchanged receipt SHA', () => {
  const f = releaseEvidenceFixture(), map = f.inventory.source.candidates.find(m => m.matchId === '201')!;
  map.radiantWin = !map.radiantWin; if (map.outcome.status === 'verified') map.outcome.teamAWon = map.radiantWin;
  f.inventory = freezeV1ReleaseInventory(f.inventory);
  const result = prepare(f); expect(result.rows.find(r => r.matchId === '201')!.reasons).toContain('CANONICAL_FACTS_MISMATCH');
  expect(result.historyExclusions).toEqual([{ matchId: '201', reason: 'CAPTURED_DETAIL_CONFLICTS_WITH_HISTORY' }]);
  expect(result.rows.find(r => r.matchId === '202')!.historyCoverage!.minimumPlayerMaps).toBe(6);
});
it('uses lower numeric canonical team ID for A and rejects provider-team mismatches', () => {
  const f = releaseEvidenceFixture(), map = f.inventory.source.candidates.find(m => m.matchId === '201')!;
  map.radiantTeamId = '33'; if (map.outcome.status === 'verified') map.outcome.teamAId = '33';
  f.inventory.source.aliases.find(a => a.seriesId === map.seriesId)!.teamAId = '33';
  f.inventory = freezeV1ReleaseInventory(f.inventory);
  expect(prepare(f).rows.find(r => r.matchId === '201')!.teamASide).toBe('dire');
  f.inventory.metadata.find(m => m.matchId === '201')!.radiantProviderTeamId = '999';
  f.inventory = freezeV1ReleaseInventory(f.inventory);
  expect(prepare(f).rows.find(r => r.matchId === '201')!.reasons).toContain('CANONICAL_EVENT_OR_TEAMS_MISMATCH');
});
it('validates all fixed batches and immutable hashes; cannot accept missing, duplicate or late details', () => {
  const f = releaseEvidenceFixture(); expect(() => prepare({ ...f, batches: [] })).toThrow('release_detail_batches');
  expect(() => prepare({ ...f, batches: [...f.batches, ...f.batches] })).toThrow('release_detail_batches');
  f.batches[0]!.report.completedAt = '2027-01-01T00:00:00.000Z'; f.batches[0]!.report = reseal(f.batches[0]!.report);
  expect(() => prepare(f)).toThrow('release_detail_binding');
});
it('freezes and replays a source capture without metrics and rejects early/future/tampered captures', () => {
  const f = releaseEvidenceFixture(), at = f.plan.evaluateNotBefore;
  const capture = freezeV1ReleaseCapture(f.plan, f.candidate, f.inventory, f.ledger, f.batches, at, f.files, 'e'.repeat(64), f.code);
  expect(verifyV1ReleaseCapture(f.plan, f.candidate, capture, f.ledger, f.batches, at).capture).toEqual(capture);
  expect(() => freezeV1ReleaseCapture(f.plan, f.candidate, null, f.ledger, f.batches, f.at, f.files, 'e'.repeat(64), f.code)).toThrow('release_capture_too_early');
  expect(() => verifyV1ReleaseCapture(f.plan, f.candidate, null, f.ledger, f.batches, f.at)).toThrow('release_capture_too_early');
  expect(() => verifyV1ReleaseCapture(f.plan, f.candidate, { ...capture, capturedAt: '2999-01-01T00:00:00.000Z' }, f.ledger, f.batches, at)).toThrow('release_capture_in_future');
  expect(() => verifyV1ReleaseCapture(f.plan, f.candidate, { ...capture, bindingFingerprint: '0'.repeat(64) }, f.ledger, f.batches, at)).toThrow('release_capture_replay_mismatch');
});
it('handles an empty target scope with nullable coverage and no detail batch', () => {
  const f = releaseEvidenceFixture(), rawBody = '[]';
  f.ledger = buildEvaluationDiscoveryLedger(f.ledger.scope, [{ status: 'captured', sequence: 0, endpoint: '/proMatches',
    fetchedAt: f.at, rawBody, payloadSha256: releaseSha(rawBody) }], f.at, f.at, f.limits, ['PRO_PAGE_LIMIT']);
  f.inventory.source.candidates = f.inventory.source.candidates.filter(m => !['201', '202'].includes(m.matchId));
  f.inventory.metadata = f.inventory.metadata.filter(m => !['201', '202'].includes(m.matchId));
  f.inventory = freezeV1ReleaseInventory(f.inventory); f.batches = [];
  expect(prepare(f).coverage).toEqual({ observedTargetMaps: 0, dataReadyMaps: 0, mapCoverage: null,
    observedKnownSeries: 0, dataReadySeries: 0, knownSeriesCoverage: null });
});
it('keeps failed detail receipts visible while retaining independently verified history', () => {
  const f = releaseEvidenceFixture(), entries: unknown[] = structuredClone(f.detailEntries);
  entries[2] = { status: 'failed', endpoint: '/matches/201', matchId: '201', failedAt: f.at, code: 'timeout' };
  f.batches = [validateEvaluationDetails(f.ledger, entries, 0, f.at, f.at)];
  const result = prepare(f); expect(result.coverage.observedTargetMaps).toBe(2);
  expect(result.rows.find(r => r.matchId === '201')!.sourceReasons).toContain('DETAIL_FETCH_FAILED');
  expect(result.rows.find(r => r.matchId === '202')!.historyCoverage!.minimumPlayerMaps).toBe(7);
});
