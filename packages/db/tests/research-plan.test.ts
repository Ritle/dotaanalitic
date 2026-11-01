import { expect, it } from 'vitest';
import { planResearchElo } from '../src/research-plan.js';
import { freezeResearchElo } from '../src/research-elo.js';
import { planFixture, registeredAt } from './research-plan-fixtures.js';
const plan = (f = planFixture(), clock = registeredAt) => planResearchElo(f.request, f.prior, f.discovery, clock);
it('pins future windows and fixed Elo while separating discovery candidates from verified maps', () => {
  expect(plan()).toMatchObject({ syntheticOnly: true, trainingReady: false, deployable: false,
    warmup: { candidateMaps: 3, candidateSeries: 2, verifiedNewMaps: 0 },
    holdout: { status: 'not_started', candidateMaps: null, metrics: null, earlyScoring: 'forbidden_before_evaluationNotBefore' } });
});
it('is deterministic and cannot select warmup maps by their outcomes', () => {
  const f = planFixture(), original = plan(f), before = JSON.stringify(f);
  expect(plan(f)).toEqual(original); expect(JSON.stringify(f)).toBe(before);
  f.discovery.cohorts[0]!.matches.forEach(m => { m.radiant_win = false; });
  expect(plan(f)).toEqual(original);
  f.discovery.cohorts[0]!.matches.reverse(); expect(plan(f)).toEqual(original);
});
it('rejects registration on/after holdout and prior observations from that period', () => {
  expect(() => plan(planFixture(), '2026-11-02T00:00:00.000Z')).toThrow('registration_must_precede_holdout');
  const f = planFixture(); f.prior.candidates[0]!.startedAtUs = (BigInt(Date.parse(f.request.holdoutFromAt)) * 1000n).toString();
  const { fingerprint: _, ...body } = f.prior; f.prior = freezeResearchElo(body);
  expect(() => plan(f)).toThrow('prior_map_in_future_holdout');
});
it('rejects forged prior fingerprints, duplicate discovery ids and overflow without truncation', () => {
  const f = planFixture(); f.prior.fingerprint = '0'.repeat(64); expect(() => plan(f)).toThrow('prior_export_fingerprint_mismatch');
  const duplicate = planFixture(); duplicate.discovery.cohorts[0]!.matches.push(duplicate.discovery.cohorts[0]!.matches[0]!);
  expect(() => plan(duplicate)).toThrow('duplicate_discovery_map');
  const overflow = planFixture(); overflow.request.maxWarmupCandidates = 2; expect(() => plan(overflow)).toThrow('warmup_inventory_limit');
});
it('excludes every known sibling if a series crosses the warmup boundary', () => {
  const f = planFixture(); f.discovery.cohorts[0]!.matches[1]!.start_time = Date.parse(f.request.holdoutFromAt) / 1000;
  expect(plan(f).warmup.assessments.filter(m => m.seriesKey === 'opendota:99').every(m => m.reasons.includes('SERIES_OUTSIDE_WARMUP'))).toBe(true);
  expect(plan(f).warmup.candidateMaps).toBe(1);
});
it('keeps prior series and conflicting organization pairs out of the new fetch inventory', () => {
  const f = planFixture(); f.prior.aliases[0]!.providerSeriesId = '99';
  const { fingerprint: _, ...body } = f.prior; f.prior = freezeResearchElo(body);
  expect(plan(f).warmup.candidateMaps).toBe(1);
  const conflict = planFixture(); conflict.discovery.cohorts[0]!.matches[1]!.dire_team_id = '33';
  expect(plan(conflict).warmup.candidateMaps).toBe(1);
});
it('fails closed on mismatched league/tier/source endpoint and evidence after registration', () => {
  for (const field of ['tier', 'endpoint', 'time', 'league'] as const) {
    const f = planFixture(), cohort = f.discovery.cohorts[0]!;
    if (field === 'tier') cohort.tier = 'amateur';
    if (field === 'endpoint') cohort.source_evidence.endpoint = '/other';
    if (field === 'time') cohort.source_evidence.fetched_at = '2026-11-02T00:00:00.000Z';
    if (field === 'league') cohort.matches[0]!.leagueid = '88';
    expect(() => plan(f)).toThrow();
  }
});
it('records an empty discovery as zero candidates and does not invent holdout metrics', () => {
  const f = planFixture(); f.discovery.cohorts[0]!.matches = [];
  expect(plan(f)).toMatchObject({ warmup: { candidateMaps: 0 }, holdout: { eligibleMaps: null, metrics: null } });
});
