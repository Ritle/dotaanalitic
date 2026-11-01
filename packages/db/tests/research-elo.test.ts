import { expect, it } from 'vitest';
import { freezeResearchElo, evaluateResearchElo } from '../src/research-elo.js';
import { researchFixture, micros } from './research-elo-fixtures.js';
const evaluate = (body = researchFixture()) => evaluateResearchElo(freezeResearchElo(body));
it('scores the approved research cohort while preserving unknown historical availability and all deployment gates', () => {
  const body = researchFixture(), report = evaluate(body);
  expect(report).toMatchObject({ status: 'research_complete', trainingReady: false, deployable: false, syntheticOnly: true,
    teamAWinProbability: null, historicalAvailability: 'not_verified', prospectiveAccuracy: 'not_assessed',
    summary: { candidateMaps: 6, eligibleMaps: 6, warmupMaps: 3, scoredMaps: 3, holdoutSeries: 3 } });
  expect(report.metrics?.constantPriorBaseline).toMatchObject({ brier: 0.25, n: 3 });
  expect(report.metrics?.brier).toBeGreaterThan(0); expect(report.metrics?.logLoss).toBeGreaterThan(0);
  expect(freezeResearchElo(body).candidates[0]!.facts[0]!.knownAtUs).toBeNull();
  expect(JSON.stringify(report)).not.toMatch(/ratingDelta|ratingBefore|expectedWin|radiantWinProbability/);
});
it('future and current target outcomes cannot change their start-time feature fingerprints', () => {
  const original = evaluate(), body = researchFixture(), map = body.candidates[3]!;
  map.radiantWin = !map.radiantWin; if (map.outcome.status === 'verified') map.outcome.teamAWon = map.radiantWin;
  const changed = evaluate(body);
  expect(changed.observations.slice(0, 4)).toEqual(original.observations.slice(0, 4));
  expect(changed.observations[4]!.featureFingerprint).not.toBe(original.observations[4]!.featureFingerprint);
});
it('swapping all native sides preserves aggregate scoring', () => {
  const body = researchFixture();
  for (const m of body.candidates) {
    m.players = m.players.map(p => ({ ...p, playerSlot: p.playerSlot < 128 ? p.playerSlot + 128 : p.playerSlot - 128 }));
    m.receiptPlayers = structuredClone(m.players); [m.radiantTeamId, m.direTeamId] = [m.direTeamId, m.radiantTeamId];
    m.radiantWin = !m.radiantWin;
    if (m.outcome.status === 'verified') { m.outcome.teamAWon = m.radiantWin; [m.outcome.teamAId, m.outcome.teamBId] = [m.outcome.teamBId, m.outcome.teamAId]; }
  }
  expect(evaluate(body).metrics?.brier).toBeCloseTo(evaluate().metrics!.brier, 14);
  expect(evaluate(body).metrics?.logLoss).toBeCloseTo(evaluate().metrics!.logLoss, 14);
});
it('player history survives an organization transfer without inheriting an organization rating', () => {
  const body = researchFixture(), m = body.candidates[3]!; m.radiantTeamId = '33';
  if (m.outcome.status === 'verified') m.outcome.teamAId = '33'; body.aliases[3]!.teamAId = '33';
  expect(evaluate(body).metrics).toEqual(evaluate().metrics);
});
it('refuses corrupt outcomes, source-account lineups and unverified identities rather than guessing', () => {
  for (const change of ['outcome', 'roster', 'identity', 'pro', 'series'] as const) {
    const body = researchFixture(), m = body.candidates[0]!;
    if (change === 'outcome' && m.outcome.status === 'verified') m.outcome.teamAWon = !m.outcome.teamAWon;
    if (change === 'roster') m.receiptPlayers[0]!.sourceAccountId = '999';
    if (change === 'identity') body.identities = [];
    if (change === 'pro') m.isPro = null;
    if (change === 'series') m.seriesSourceMatched = false;
    expect(evaluate(body).assessments[0]!.split).toBeNull();
  }
});
it('never double-counts duplicate map ids and does not accept forged fingerprints', () => {
  const body = researchFixture(); body.candidates.push(structuredClone(body.candidates[0]!));
  expect(() => evaluate(body)).toThrow('research_duplicate_map');
  const frozen = freezeResearchElo(researchFixture()); frozen.candidates[0]!.radiantWin = false;
  expect(() => evaluateResearchElo(frozen)).toThrow('research_export_fingerprint_mismatch');
});
it('canonicalizes input order and does not mutate the source data', () => {
  const body = researchFixture(), before = JSON.stringify(body), frozen = freezeResearchElo(body);
  expect(JSON.stringify(body)).toBe(before);
  body.candidates.reverse(); body.identities.reverse(); body.aliases.reverse(); body.candidates.forEach(m => { m.players.reverse(); m.receiptPlayers.reverse(); });
  expect(freezeResearchElo(body)).toEqual(frozen);
});
it('excludes whole provider-series aliases crossing holdout and aliases with conflicting teams even without maps', () => {
  const body = researchFixture(); body.aliases[3]!.providerSeriesId = body.aliases[0]!.providerSeriesId;
  const report = evaluate(body);
  expect(report.assessments.filter(r => ['1', '4'].includes(r.matchId)).every(r => r.reasons.includes('SERIES_CROSSES_HOLDOUT'))).toBe(true);
  const conflict = researchFixture(); conflict.aliases.push({ ...conflict.aliases[0]!, seriesId: '99999999-0000-4000-8000-000000000000', teamAId: '99' });
  expect(evaluate(conflict).assessments[0]!.reasons).toContain('SERIES_ORGANIZATION_CONFLICT');
});
it('includes out-of-window siblings when excluding a series', () => {
  const body = researchFixture(); body.request.fromAt = '2024-01-02T00:00:00.000Z';
  body.aliases[1]!.providerSeriesId = body.aliases[0]!.providerSeriesId;
  expect(evaluate(body).assessments.find(r => r.matchId === '2')!.reasons).toContain('SERIES_OUTSIDE_WINDOW');
});
it('excludes overlapping series and a warmup group that finishes a microsecond into holdout', () => {
  const body = researchFixture(), first = body.candidates[0]!, second = body.candidates[1]!;
  second.startedAtUs = first.startedAtUs; second.endedAtUs = first.endedAtUs;
  if (first.outcome.status === 'verified' && second.outcome.status === 'verified') {
    second.outcome.startedAt = first.outcome.startedAt; second.outcome.completedAt = first.outcome.completedAt;
  }
  expect(evaluate(body).assessments.slice(0, 2).every(r => r.reasons.includes('SERIES_TIME_OVERLAP'))).toBe(true);
  const edge = researchFixture(); edge.candidates[2]!.endedAtUs = (BigInt(micros(edge.request.holdoutFromAt)) + 1n).toString();
  expect(evaluate(edge).assessments[2]!.reasons).toContain('SERIES_CROSSES_HOLDOUT');
});
it('returns null metrics for zero sample or no usable warmup, never a fabricated prediction', () => {
  const empty = researchFixture(); empty.candidates = []; empty.aliases = [];
  expect(evaluate(empty)).toMatchObject({ status: 'unavailable', metrics: null, summary: { scoredMaps: 0 }, teamAWinProbability: null });
  const noWarmup = researchFixture(); noWarmup.candidates = noWarmup.candidates.slice(3);
  expect(evaluate(noWarmup)).toMatchObject({ reason: 'NO_WARMUP_MAPS', metrics: null });
});
it('does not use late current identity evidence or canonical data beyond the export snapshot', () => {
  const body = researchFixture(); body.identities.forEach(r => { r.fetchedAt = '2026-11-01T00:00:00.000Z'; });
  expect(evaluate(body).summary.eligibleMaps).toBe(0);
  const later = researchFixture(); later.candidates[0]!.syncedAtUs = micros('2026-11-01T00:00:00.000Z');
  expect(evaluate(later).assessments[0]!.reasons).toContain('CANONICAL_STATE_AFTER_SNAPSHOT');
});
it('rejects invalid windows, changed policy and mixed registry/production export formats', () => {
  const body = researchFixture(); body.request.holdoutFromAt = body.request.fromAt;
  expect(() => freezeResearchElo(body)).toThrow();
  expect(() => freezeResearchElo({ ...researchFixture(), policy: { ...researchFixture().policy, k: 16 } })).toThrow();
  expect(() => freezeResearchElo({ ...researchFixture(), trainingReady: true })).toThrow();
  expect(() => freezeResearchElo({ ...researchFixture(), format: 'prepared-context-v1' })).toThrow();
});
