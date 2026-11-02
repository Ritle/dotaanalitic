import { expect, it } from 'vitest';
import { evaluateResearchElo, freezeResearchElo } from '../../db/src/research-elo.js';
import { validateEvaluationDetails } from '../src/evaluation-details.js';
import { canonicalContextJson } from '../../db/src/temporal.js';
import { freezeEvidenceResearchExecution, evaluateEvidenceResearchExecution, prepareResearchEvidence } from '../src/research-evidence.js';
import { evidenceFixture, digest } from './research-evidence-fixtures.js';
const freeze = (f: ReturnType<typeof evidenceFixture>) => freezeEvidenceResearchExecution(f.plan, f.snapshot, f.now, f.code, f.files, f.ledger, f.batches);
const score = (f: ReturnType<typeof evidenceFixture>) => evaluateEvidenceResearchExecution(f.plan, freeze(f), f.ledger, f.batches, f.now);

it('preserves exact E0 scoring with complete evidence and replays without mutating facts', () => {
  const f = evidenceFixture(), before = JSON.stringify(f), result = score(f);
  expect(result.evaluation).toEqual(evaluateResearchElo(f.snapshot));
  expect(result.coverage).toMatchObject({ observedTargetMaps: 2, scoredMaps: 2, mapCoverage: 1, observedKnownSeries: 2 });
  expect(score(f)).toEqual(result); expect(JSON.stringify(f)).toBe(before);
  expect(result).toMatchObject({ deployable: false, releaseGate: 'not_assessed', teamAWinProbability: null });
});

it('keeps missing imports in denominator and excludes their whole observed series', () => {
  const result = score(evidenceFixture(['201', '202', '203']));
  expect(result.coverage).toMatchObject({ observedTargetMaps: 3, scoredMaps: 1, mapCoverage: 1 / 3, knownSeriesCoverage: 0.5 });
  expect(result.targets.find(r => r.matchId === '203')?.reasons).toContain('EVIDENCE_CANONICAL_MAP_MISSING');
  expect(result.evaluation.assessments.find(r => r.matchId === '201')?.split).toBeNull();
  expect(result.evaluation.summary.holdoutMaps).toBe(1);
});

it('retains local holdout maps absent from discovery and refuses to score them', () => {
  const result = score(evidenceFixture(['201']));
  expect(result.coverage).toMatchObject({ observedTargetMaps: 2, scoredMaps: 1 });
  expect(result.targets.find(r => r.matchId === '202')?.reasons).toContain('EVIDENCE_LOCAL_TARGET_UNDISCOVERED');
});

it('propagates every conflicting source series key rather than selecting the convenient variant', () => {
  const result = score(evidenceFixture(['201', '202'], true));
  expect(result.coverage.scoredMaps).toBe(0); expect(result.evaluation.metrics).toBeNull();
  expect(result.targets.find(r => r.matchId === '202')?.reasons).toContain('EVIDENCE_SERIES_MEMBER_EXCLUDED');
});

it('requires all fixed batches, rejects a missing, duplicate or altered batch even with a refreshed hash', () => {
  const f = evidenceFixture(Array.from({ length: 51 }, (_, i) => String(201 + i)));
  expect(f.batches).toHaveLength(2); expect(() => freeze(f)).not.toThrow();
  expect(() => freeze({ ...f, batches: f.batches.slice(0, 1) })).toThrow('execution_evidence_batches');
  expect(() => freeze({ ...f, batches: [f.batches[0]!, f.batches[0]!] })).toThrow('execution_evidence_batches');
  const edited = structuredClone(f.batches); edited[1]!.assessments = [];
  const { fingerprint: _old, ...body } = edited[1]!; edited[1]!.fingerprint = digest(canonicalContextJson(body));
  expect(() => freeze({ ...f, batches: edited })).toThrow('execution_evidence_batches');
});

it('enforces the unchanged time/scope boundary before parsing or scoring and rejects later evidence', () => {
  const f = evidenceFixture();
  expect(() => evaluateEvidenceResearchExecution(f.plan, null, f.ledger, [], '2026-11-09T23:59:59.999Z')).toThrow('execution_too_early');
  expect(() => freeze({ ...f, ledger: { ...f.ledger, scope: { ...f.ledger.scope, kind: 'v1' } } })).toThrow('execution_evidence_scope');
  expect(() => freeze({ ...f, ledger: { ...f.ledger, completedAt: '2026-11-11T00:00:00.000Z' } })).toThrow('execution_evidence_horizon');
});

it('rejects evidence/capture tampering and canonical receipt mismatch without rewriting the outcome', () => {
  const f = evidenceFixture(), captured = freeze(f);
  expect(() => evaluateEvidenceResearchExecution(f.plan, { ...captured, evidenceFingerprint: 'f'.repeat(64) }, f.ledger, f.batches, f.now)).toThrow('execution_evidence_binding');
  const altered = structuredClone(f.batches); altered[0]!.assessments[0]!.payloadSha256 = 'f'.repeat(64);
  expect(() => prepareResearchEvidence(f.plan, f.snapshot, f.ledger, altered)).toThrow('execution_evidence_batch_binding');
});

it('keeps a failed detail response in coverage even when a canonical map already exists', () => {
  const f = evidenceFixture(), entries: unknown[] = structuredClone(f.captures[0]!.entries);
  entries[2] = { status: 'failed', endpoint: '/matches/201', matchId: '201', failedAt: f.ledger.completedAt, code: 'http_error' };
  f.batches = [validateEvaluationDetails(f.ledger, entries, 0, f.ledger.completedAt, f.ledger.completedAt).report];
  const result = score(f);
  expect(result.coverage).toMatchObject({ observedTargetMaps: 2, scoredMaps: 1 });
  expect(result.targets.find(r => r.matchId === '201')?.sourceReasons).toContain('DETAIL_FETCH_FAILED');
});

it('returns null coverage for zero target maps and retains no-holdout unavailable status', () => {
  const f = evidenceFixture([]), { fingerprint: _old, ...body } = f.snapshot;
  body.candidates = body.candidates.filter(m => BigInt(m.startedAtUs) < BigInt(Date.parse(f.plan.request.holdoutFromAt)) * 1000n);
  f.snapshot = freezeResearchElo(body);
  const result = score(f);
  expect(result.coverage).toMatchObject({ observedTargetMaps: 0, scoredMaps: 0, mapCoverage: null, knownSeriesCoverage: null });
  expect(result.evaluation).toMatchObject({ status: 'unavailable', metrics: null });
});

it('rejects canonical payload mismatch while preserving the original map outcome', () => {
  const f = evidenceFixture(), { fingerprint: _old, ...body } = structuredClone(f.snapshot);
  const map = body.candidates.find(m => m.matchId === '201')!;
  if (map.outcome.status !== 'verified') throw Error('fixture');
  map.outcome.sourceEvidence.payloadSha256 = 'f'.repeat(64); f.snapshot = freezeResearchElo(body);
  const before = JSON.stringify(f.snapshot), result = score(f);
  expect(result.coverage.scoredMaps).toBe(1);
  expect(result.targets.find(r => r.matchId === '201')?.reasons).toContain('EVIDENCE_RECEIPT_MISMATCH');
  expect(JSON.stringify(f.snapshot)).toBe(before);
});
