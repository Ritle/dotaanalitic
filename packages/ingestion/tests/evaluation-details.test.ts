import { expect, it } from 'vitest';
import { captureEvaluationDetails, selectEvaluationDetailBatch, validateEvaluationDetails, reconcileEvaluationCandidates } from '../src/evaluation-details.js';
import { prepareV1Data } from '../../db/src/v1-data.js';
import { OpenDotaClient } from '../src/opendota/client.js';
import { detailTime, detailsFixture, detailObservation } from './evaluation-details-fixtures.js';
const validated = (f = detailsFixture()) => validateEvaluationDetails(f.ledger, f.entries, 0, detailTime, detailTime);

it('validates source-only pro outcome/account metadata and replays the same bytes without inferring canonical identities', async () => {
  const f = detailsFixture(), result = validated(f);
  expect(result.report).toMatchObject({ deployable: false, metrics: null, proEligibility: 'canonical_verification_required',
    assessments: [{ matchId: '1', sourceEligible: true, reasons: [] }] });
  expect((await result.provider.getMatchSource('1')).rawBody).toBe(f.entries[2]!.observation.rawBody);
  expect(await result.provider.getLeagues()).toMatchObject({ data: [{ leagueid: '77' }] });
  await expect(result.provider.getMatchSource('999')).rejects.toThrow('detail_not_importable');
});

it('never loses failed or deferred IDs from the candidate inventory', () => {
  const f = detailsFixture();
  const failed = { status: 'failed', endpoint: '/matches/1', matchId: '1', failedAt: detailTime, code: 'source_rate_limited' };
  const report = validateEvaluationDetails(f.ledger, [...f.entries.slice(0, 2), failed], 0, detailTime, detailTime).report;
  expect(report.assessments[0]!.reasons).toContain('DETAIL_FETCH_FAILED');
  const missing = { ...f.source, candidates: f.source.candidates.slice(1) };
  const reconciled = reconcileEvaluationCandidates(f.ledger, prepareV1Data(missing), report);
  expect(reconciled.coverage).toMatchObject({ observedTargetMaps: 1, dataReadyMaps: 0, mapCoverage: 0 });
  expect(reconciled.assessments[0]!.reasons).toContain('CANONICAL_MAP_MISSING');
});

it('uses fixed numeric batches and exposes every deferred ID without selecting by result or quality', () => {
  const f = detailsFixture(), base = f.ledger.candidates[0]!;
  const ledger = { ...f.ledger, candidates: Array.from({ length: 51 }, (_, i) => ({ ...base, matchId: String(51 - i) })) };
  const a = selectEvaluationDetailBatch(ledger, 0), b = selectEvaluationDetailBatch(ledger, 1);
  expect(a.selectedIds).toHaveLength(50); expect(a.deferredIds).toEqual(['51']); expect(b.selectedIds).toEqual(['51']);
  expect(b.deferredIds).toHaveLength(50); expect(() => selectEvaluationDetailBatch(ledger, -1)).toThrow();
  const empty = validated(f); const deferred = validateEvaluationDetails(f.ledger, [], 1, detailTime, detailTime);
  expect(reconcileEvaluationCandidates(f.ledger, f.dataset, deferred.report).coverage.mapCoverage).toBe(0);
  expect(empty.report.assessments).toHaveLength(1);
});

it('rejects dropped/duplicate/out-of-selection receipts, tampered SHA and invalid clocks', () => {
  const f = detailsFixture();
  expect(() => validateEvaluationDetails(f.ledger, f.entries.slice(0, 2), 0, detailTime, detailTime)).toThrow('detail_receipt_inventory_invalid');
  expect(() => validateEvaluationDetails(f.ledger, [...f.entries, f.entries[2]], 0, detailTime, detailTime)).toThrow('detail_receipt_inventory_invalid');
  const changed = structuredClone(f.entries); changed[2]!.observation.rawBody = 'private-sentinel';
  expect(() => validateEvaluationDetails(f.ledger, changed, 0, detailTime, detailTime)).toThrow('detail_source_binding_invalid');
  expect(() => validateEvaluationDetails(f.ledger, f.entries, 0, '2026-11-01T23:00:00.000Z', detailTime)).toThrow('detail_capture_clock_invalid');
});

it('rejects metadata disagreements, unverified leagues, missing numeric accounts and late source evidence', () => {
  for (const change of [
    (f: ReturnType<typeof detailsFixture>) => { f.payload.series_id = '99'; },
    (f: ReturnType<typeof detailsFixture>) => { f.payload.start_time++; },
    (f: ReturnType<typeof detailsFixture>) => { f.payload.players[0]!.account_id = null; }
  ]) {
    const f = detailsFixture(); change(f); const o = detailObservation('/matches/1', f.payload);
    f.entries[2]!.observation = { source: o.source, rawBody: o.rawBody };
    expect(validated(f).report.assessments[0]!.sourceEligible).toBe(false);
  }
  const g = detailsFixture(), l = detailObservation('/leagues', [{ leagueid: 77, name: 'Synthetic', tier: 'amateur' }]);
  g.entries[1]!.observation = { source: l.source, rawBody: l.rawBody };
  expect(validated(g).report.assessments[0]!.reasons).toContain('PRO_STATUS_UNVERIFIED');
  const h = detailsFixture(); h.ledger.scope.snapshotAt = '2026-10-31T00:00:00.000Z';
  expect(validated(h).report.assessments[0]!.reasons).toContain('SOURCE_AFTER_EVALUATION_SNAPSHOT');
});

it('requires both a verified canonical outcome and canonical player/series eligibility, not source shape alone', () => {
  const f = detailsFixture(), report = validated(f).report;
  const ready = reconcileEvaluationCandidates(f.ledger, f.dataset, report);
  expect(ready.coverage).toMatchObject({ observedTargetMaps: 1, dataReadyMaps: 1, mapCoverage: 1, targetMapsWithVerifiedOutcomes: 1 });
  f.source.identities = [];
  const unknown = reconcileEvaluationCandidates(f.ledger, prepareV1Data(f.source), report);
  expect(unknown.assessments[0]!.reasons).toContain('CURRENT_IDENTITIES_UNVERIFIED'); expect(unknown.coverage.mapCoverage).toBe(0);
  expect(unknown).toMatchObject({ metrics: null, deployable: false });
});

it('excludes a whole observed series if a discovered sibling has not been imported', () => {
  const f = detailsFixture(), original = f.ledger.candidates[0]!;
  f.ledger.candidates.push({ ...structuredClone(original), matchId: '999', metadata: { ...original.metadata, match_id: '999' } });
  const report = validateEvaluationDetails(f.ledger, [...f.entries, { status: 'failed', endpoint: '/matches/999', matchId: '999', failedAt: detailTime, code: 'source_http_error' }], 0, detailTime, detailTime).report;
  const reconciliation = reconcileEvaluationCandidates(f.ledger, f.dataset, report);
  expect(reconciliation.coverage).toMatchObject({ observedTargetMaps: 2, dataReadyMaps: 0, observedKnownSeries: 1, knownSeriesCoverage: 0 });
  expect(reconciliation.assessments[0]!.reasons).toContain('DISCOVERED_SERIES_HAS_UNREADY_OR_OUTSIDE_MEMBER');
});

it('also checks canonical siblings outside target windows, even if discovery did not list them', () => {
  const f = detailsFixture(), first = f.source.candidates[0]!, sibling = f.source.candidates[1]!;
  f.ledger.scope.windows[0]!.until = '2024-01-02T00:00:00.000Z';
  sibling.seriesId = first.seriesId;
  if (sibling.outcome.status === 'verified') sibling.outcome.seriesId = first.seriesId;
  const report = reconcileEvaluationCandidates(f.ledger, prepareV1Data(f.source), validated(f).report);
  expect(report.coverage.dataReadyMaps).toBe(0);
  expect(report.assessments[0]!.reasons).toContain('CANONICAL_SERIES_OUTSIDE_TARGET_WINDOW');
});

it('groups a discovery-unknown series by its canonical link, retaining an unimported observed sibling', () => {
  const f = detailsFixture(), candidate = f.ledger.candidates[0]!;
  candidate.seriesKey = null; candidate.metadata.series_id = null;
  for (const o of candidate.observations) o.metadata.series_id = null;
  f.ledger.candidates.push({ ...structuredClone(candidate), matchId: '999', seriesKey: 'opendota:1', metadata: { ...candidate.metadata, match_id: '999', series_id: '1' } });
  const report = validateEvaluationDetails(f.ledger, [...f.entries, { status: 'failed', endpoint: '/matches/999', matchId: '999', failedAt: detailTime, code: 'source_http_error' }], 0, detailTime, detailTime).report;
  const result = reconcileEvaluationCandidates(f.ledger, f.dataset, report);
  expect(result.coverage.dataReadyMaps).toBe(0);
  expect(result.assessments[0]!.reasons).toContain('DISCOVERED_SERIES_HAS_UNREADY_OR_OUTSIDE_MEMBER');
});

it('captures every receipt before continuing and retains network failures without leaking errors', async () => {
  const f = detailsFixture(), calls: string[] = [], persisted: string[] = [];
  const provider = new OpenDotaClient({ attempts: 1 }, { now: () => Date.parse(detailTime), sleep: async () => {}, fetch: async url => {
    calls.push(url.pathname); return url.pathname.endsWith('/matches/1') ? new Response('', { status: 500 }) :
      new Response(url.pathname.endsWith('/heroes') ? f.entries[0]!.observation.rawBody : f.entries[1]!.observation.rawBody);
  } });
  const result = await captureEvaluationDetails(f.ledger, 0, provider, async e => { persisted.push(e.endpoint); }, () => detailTime);
  expect(calls).toHaveLength(3); expect(persisted).toEqual(['/heroes', '/leagues', '/matches/1']);
  expect(result.report.assessments[0]!.reasons).toContain('DETAIL_FETCH_FAILED');
  await expect(captureEvaluationDetails(f.ledger, 0, provider, async () => { throw Error('disk-full'); }, () => detailTime)).rejects.toThrow('disk-full');
});
