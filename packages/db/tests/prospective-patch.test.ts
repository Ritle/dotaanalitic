import { expect, it } from 'vitest';
import { ProspectivePatchInputSchema, type ProspectivePatchEvidence, type ProspectivePatchRequest } from '@dota/contracts';
import { prepareProspectivePatchContext } from '../src/prospective-patch.js';
import { resolvePatchAt } from '../src/game-context.js';

// All proofs and labels in this file are synthetic; no registry writes.
const cutoffAt = '2026-11-01T20:00:00.000Z';
const before = '2026-11-01T19:59:00.000Z';
const after = '2026-11-01T20:00:00.001Z';
const request: ProspectivePatchRequest = {
  cutoffAt, target: { kind: 'single_map_scenario', scenarioId: '123e4567-e89b-42d3-a456-426614174000',
    scenarioRevision: 1, leagueId: '10', scheduledMapAt: '2026-11-02T19:00:00.000Z' },
  assumption: 'same_as_observed', freshness: { policyRevision: 'synthetic-60s', maxAgeSeconds: 60 }
};
function proof(overrides: Partial<ProspectivePatchEvidence> = {}): ProspectivePatchEvidence {
  return { id: '9007199254740993', kind: 'active_version', patchLabel: '7.41f', scope: { kind: 'game' },
    eventAt: before, knownAt: before, fetchedAt: before, recordedAt: before, reviewedAt: before,
    source: 'synthetic-only', evidenceRef: 'synthetic:active-version', payloadSha256: 'a'.repeat(64),
    reviewState: 'accepted', ...overrides } as ProspectivePatchEvidence;
}
function run(evidence: ProspectivePatchEvidence[] = [proof()], change: Partial<ProspectivePatchRequest> = {}) {
  return prepareProspectivePatchContext({ request: { ...request, ...change }, evidence });
}
it('prepares a conditional future context without manufacturing actual patch or probability', () => {
  expect(run()).toMatchObject({ observed: { status: 'observed', patchLabel: '7.41f' },
    condition: { status: 'conditional', patchLabel: '7.41f' }, actualMapPatchLabel: null,
    prediction: { status: 'unavailable', teamAWinProbability: null }, trainingReady: false, deployable: false });
  expect(run().evidence[0]?.id).toBe('9007199254740993');
});
it('does not repair the historical resolver by inventing future coverage', () => {
  const row = { id: '1', patchId: '1', releasedAt: before, coverageUntil: cutoffAt, eventAt: before,
    knownAt: before, fetchedAt: cutoffAt, source: 'synthetic', evidenceRef: 'synthetic:release', reviewState: 'accepted' as const };
  expect(resolvePatchAt([row], request.target.scheduledMapAt!, cutoffAt).reason).toBe('PATCH_COVERAGE_GAP');
  expect(resolvePatchAt([row], cutoffAt, cutoffAt).reason).toBe('PATCH_COVERAGE_GAP');
  expect(resolvePatchAt([row], before, cutoffAt).value).toBe('1');
});
it('never silently opts a scenario into an assumption', () => {
  expect(run(undefined, { assumption: 'none' })).toMatchObject({ observed: { status: 'observed' },
    condition: { status: 'not_requested', patchLabel: null } });
});
it('empty evidence and accepted publications cannot stand in for an active version', () => {
  for (const evidence of [[], [proof({ kind: 'publication' })]])
    expect(run(evidence)).toMatchObject({ observed: { status: 'unknown', patchLabel: null }, condition: { status: 'unavailable' } });
});
it.each(['unverified', 'rejected'] as const)('does not promote %s active claims', reviewState => {
  expect(run([proof({ reviewState })]).observed.patchLabel).toBeNull();
});
it('filters late knowledge, fetch, recording and review before building the frozen input', () => {
  const base = run();
  for (const clocks of [
    { eventAt: after, knownAt: after, fetchedAt: after, recordedAt: after, reviewedAt: after },
    { knownAt: after, fetchedAt: after, recordedAt: after, reviewedAt: after },
    { fetchedAt: after, recordedAt: after, reviewedAt: after },
    { recordedAt: after, reviewedAt: after }, { reviewedAt: after }
  ]) expect(run([proof(), proof({ id: '2', patchLabel: '7.42', ...clocks })])).toEqual(base);
});
it('allows evidence reviewed exactly at cutoff, excludes a later correction even with the same id', () => {
  expect(run([proof({ reviewedAt: cutoffAt })]).observed.status).toBe('observed');
  expect(run([proof(), proof({ patchLabel: '7.42', reviewedAt: after })])).toEqual(run());
});
it('uses explicit freshness at cutoff, inclusive age boundary, not age at future start', () => {
  expect(run().observed.status).toBe('observed');
  const older = '2026-11-01T19:58:59.999Z';
  expect(run([proof({ eventAt: older })])).toMatchObject({ observed: { status: 'stale', patchLabel: null },
    condition: { status: 'unavailable' } });
});
it('fresh disagreement and explicit conflict fail closed regardless of input order or scope priority', () => {
  const rows = [proof(), proof({ id: '2', patchLabel: '7.42', scope: { kind: 'league', leagueId: '10' }, eventAt: cutoffAt,
    knownAt: cutoffAt, fetchedAt: cutoffAt, recordedAt: cutoffAt, reviewedAt: cutoffAt })];
  expect(run(rows).observed.status).toBe('conflict');
  expect(run([...rows].reverse())).toEqual(run(rows));
  expect(run([proof({ reviewState: 'conflict' })]).observed.patchLabel).toBeNull();
});
it('isolates leagues and never infers an unknown league from proof scope', () => {
  const other = proof({ id: '2', patchLabel: '7.42', scope: { kind: 'league', leagueId: '11' } });
  expect(run([proof(), other])).toEqual(run());
  expect(run([other], { target: { ...request.target, leagueId: null } }).observed.status).toBe('unknown');
});
it('blocks an assumption for an announced transition through the scheduled map, even at its exact time', () => {
  for (const effectiveAt of [after, request.target.scheduledMapAt, null]) {
    const notice = proof({ id: '2', kind: 'announced_transition', patchLabel: '7.42', effectiveAt });
    const result = run([proof(), notice]);
    expect(result.observed.patchLabel).toBe('7.41f');
    expect(result.condition).toMatchObject({ status: 'unavailable', patchLabel: null, reasons: ['PATCH_TRANSITION_BEFORE_MAP'] });
  }
});
it('does not use a transition later than the scheduled map or an unverified notice to establish a future patch', () => {
  const notice = proof({ id: '2', kind: 'announced_transition', patchLabel: '7.42', effectiveAt: '2026-11-03T00:00:00.000Z' });
  expect(run([proof(), notice]).condition.status).toBe('conditional');
  expect(run([proof(), { ...notice, effectiveAt: after, reviewState: 'unverified' }]).condition.status).toBe('conditional');
});
it('does not treat a past transition as a future restriction after a fresh active observation', () => {
  const notice = proof({ id: '2', kind: 'announced_transition', patchLabel: '7.41e', effectiveAt: '2026-11-01T19:58:59.999Z' });
  expect(run([proof(), notice]).condition.status).toBe('conditional');
});
it('keeps unknown map time separate from series schedule and changes snapshot on rescheduling', () => {
  expect(run(undefined, { target: { ...request.target, scheduledMapAt: null } }).condition.reasons).toContain('MAP_TIME_UNKNOWN');
  const changed = run(undefined, { target: { ...request.target, scenarioRevision: 2, scheduledMapAt: '2026-11-03T19:00:00.000Z' } });
  expect(changed.fingerprint).not.toBe(run().fingerprint);
  expect(ProspectivePatchInputSchema.safeParse({ request: { ...request, target: { ...request.target, kind: 'series' } }, evidence: [] }).success).toBe(false);
});
it('deduplicates exact proofs but rejects conflicting content for one visible immutable id', () => {
  expect(run([proof(), proof()])).toEqual(run());
  expect(() => run([proof(), proof({ patchLabel: '7.42' })])).toThrow('prospective_patch_evidence_id_conflict');
});
it('rejects malformed clocks, precision, ids, unknown fields, implicit freshness and non-future targets', () => {
  for (const change of [{ knownAt: '2026-11-01T19:58:00.000Z' }, { fetchedAt: '2026-11-01T19:58:00.000Z' },
    { recordedAt: '2026-11-01T19:58:00.000Z' }, { reviewedAt: '2026-11-01T19:58:00.000Z' },
    { eventAt: '2026-11-01T19:59:00.000001Z' }, { id: '1e3' }, { id: '9223372036854775808' }])
    expect(ProspectivePatchInputSchema.safeParse({ request, evidence: [proof(change)] }).success).toBe(false);
  for (const change of [{ freshness: undefined }, { target: { ...request.target, scheduledMapAt: cutoffAt } }, { actualPatch: '7.41f' }])
    expect(ProspectivePatchInputSchema.safeParse({ request: { ...request, ...change }, evidence: [] }).success).toBe(false);
});
it('does not mutate prior input/output; later actual version cannot rewrite a prepared context', () => {
  const input = { request: structuredClone(request), evidence: [proof()] };
  const original = JSON.stringify(input);
  const result = prepareProspectivePatchContext(input);
  expect(JSON.stringify(input)).toBe(original);
  const frozen = JSON.stringify(result);
  input.evidence[0]!.patchLabel = '7.42';
  expect(JSON.stringify(result)).toBe(frozen);
  expect(JSON.stringify({ request, evidence: [proof()] })).toBe(original);
  expect(() => prepareProspectivePatchContext({ ...input, actualMapPatchLabel: '7.42' })).toThrow();
});
it('does not infer a patch from notices alone and conservatively blocks a transition at the observation boundary', () => {
  const notice = proof({ id: '2', kind: 'announced_transition', patchLabel: '7.42', effectiveAt: before });
  expect(run([notice]).observed.patchLabel).toBeNull();
  expect(run([proof(), notice]).condition.status).toBe('unavailable');
  expect(run([proof(), { ...notice, reviewState: 'conflict', effectiveAt: after }]).condition.status).toBe('unavailable');
});
it('freezes all eligible supporting evidence in numeric id order with a policy-sensitive fingerprint', () => {
  const rows = [proof(), proof({ id: '2' })];
  const result = run(rows);
  expect(result.evidence.map(row => row.id)).toEqual(['2', '9007199254740993']);
  expect(run([...rows].reverse())).toEqual(result);
  expect(run(rows, { freshness: { ...request.freshness, policyRevision: 'synthetic-new-revision' } }).fingerprint).not.toBe(result.fingerprint);
});
