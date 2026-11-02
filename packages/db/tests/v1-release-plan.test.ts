import { expect, it } from 'vitest';
import { V1ReleasePlanRequestSchema } from '@dota/contracts';
import { planV1Release, verifyV1ReleasePlan } from '../src/v1-release-plan.js';
import { canonicalContextJson } from '../src/temporal.js';
import { prepareV1Data } from '../src/v1-data.js';
import { releasePlanFixture, releaseDigest } from './v1-release-plan-fixtures.js';
const make = (f = releasePlanFixture()) => planV1Release(f.request, f.catalogue, f.development, f.registeredAt);

it('registers an explicit event and frozen thresholds without evaluating or promoting the development corpus', () => {
  const f = releasePlanFixture(), original = JSON.stringify(f), plan = make(f);
  expect(plan).toMatchObject({ status: 'registered_not_evaluated', syntheticOnly: true, evaluation: null,
    trainingReady: false, deployable: false, teamAWinProbability: null,
    qualityPolicy: { sample: { minMaps: 100, minSeries: 40 }, scoring: { maxBrier: 0.245, maxLogLoss: 0.685 },
      calibration: { maxEce: 0.08 }, history: { cutoff: 'completed_at_strictly_before_target_start' } } });
  expect(plan.request.events).toHaveLength(1); // Other premium catalogue rows are not silently Tier 1.
  expect(verifyV1ReleasePlan(plan, f.catalogue, f.development)).toEqual(plan);
  expect(JSON.stringify(f)).toBe(original);
});

it('rejects missing scope/review, duplicate events and unknown threshold knobs', () => {
  const f = releasePlanFixture();
  for (const request of [{ ...f.request, events: [] }, { ...f.request, minMaps: 1 },
    { ...f.request, events: [...f.request.events, ...f.request.events] },
    { ...f.request, events: f.request.events.map(e => ({ ...e, tierDecision: undefined })) }]) {
    expect(() => planV1Release(request, f.catalogue, f.development, f.registeredAt)).toThrow();
  }
  const invalidId = { ...f.request, events: f.request.events.map(e => ({ ...e, leagueId: 'not-a-number' })) };
  expect(() => V1ReleasePlanRequestSchema.safeParse(invalidId)).not.toThrow();
  expect(V1ReleasePlanRequestSchema.safeParse(invalidId).success).toBe(false);
});

it('rejects registration at/after the start and future observations, validates snapshot/window ordering', () => {
  const f = releasePlanFixture();
  expect(() => planV1Release(f.request, f.catalogue, f.development, f.request.events[0]!.fromAt)).toThrow('release_registration_too_late');
  f.catalogue.source.fetchedAt = '2026-11-02T00:00:00.000Z'; expect(() => make(f)).toThrow('release_evidence_in_future');
  const g = releasePlanFixture(); g.request.events[0]!.tierDecision.reviewedAt = '2026-11-02T00:00:00.000Z';
  expect(() => make(g)).toThrow('release_evidence_in_future');
  const h = releasePlanFixture(); h.request.snapshotAt = h.request.events[0]!.until; expect(() => make(h)).toThrow();
});

it('binds IDs and exact catalogue names and refuses amateur/unverified events or conflicting rows', () => {
  for (const change of [
    (f: ReturnType<typeof releasePlanFixture>) => { f.request.events[0]!.leagueId = '999'; },
    (f: ReturnType<typeof releasePlanFixture>) => { f.request.events[0]!.catalogueName = 'Synthetic qualifiers'; },
    (f: ReturnType<typeof releasePlanFixture>) => { f.catalogue.rawBody = JSON.stringify([{ leagueid: 77, name: 'Synthetic main event', tier: 'amateur' }]); },
    (f: ReturnType<typeof releasePlanFixture>) => { const rows = JSON.parse(f.catalogue.rawBody); rows.push(rows[0]); f.catalogue.rawBody = JSON.stringify(rows); }
  ]) {
    const f = releasePlanFixture(); change(f); f.catalogue.source.payloadSha256 = releaseDigest(f.catalogue.rawBody);
    expect(() => make(f)).toThrow('release_event_binding_invalid');
  }
});

it('checks raw catalogue integrity and refuses corrupt development evidence', () => {
  const f = releasePlanFixture(); f.catalogue.rawBody = 'private-sentinel'; expect(() => make(f)).toThrow('release_catalogue_payload_mismatch');
  const g = releasePlanFixture(); g.development.report.summary.eligibleMaps = 999;
  expect(() => make(g)).toThrow('v1_dataset_fingerprint_mismatch');
});

it('rejects a development snapshot after registration and refuses reuse of future test maps', () => {
  const f = releasePlanFixture(); f.development.source.request.snapshotAt = '2026-11-02T00:00:00.000Z';
  f.development = prepareV1Data(f.development.source); expect(() => make(f)).toThrow('release_development_overlaps_test');
  const g = releasePlanFixture(); g.development.source.candidates[0]!.startedAtUs = (BigInt(Date.parse(g.request.events[0]!.fromAt)) * 1000n).toString();
  g.development = prepareV1Data(g.development.source); expect(() => make(g)).toThrow('release_development_overlaps_test');
});

it('rejects edited thresholds even with a recomputed fingerprint and does not share mutable policy state', () => {
  const f = releasePlanFixture(), plan = make(f);
  const forged = { ...plan, qualityPolicy: { ...plan.qualityPolicy, sample: { ...plan.qualityPolicy.sample, minMaps: 1 } } };
  const { fingerprint: _hash, ...body } = forged; forged.fingerprint = releaseDigest(canonicalContextJson(body));
  expect(() => verifyV1ReleasePlan(forged, f.catalogue, f.development)).toThrow('release_plan_replay_mismatch');
  expect(make(f)).toEqual(plan);
});

it('has outcome-independent policy and no hidden per-map predictions', () => {
  const f = releasePlanFixture(), before = make(f);
  for (const m of f.development.source.candidates) {
    m.radiantWin = !m.radiantWin;
    if (m.outcome.status === 'verified') m.outcome.teamAWon = m.radiantWin;
  }
  f.development = prepareV1Data(f.development.source);
  const after = make(f);
  expect(after.qualityPolicy).toEqual(before.qualityPolicy);
  expect(after.request.events).toEqual(before.request.events);
  expect(after.evaluation).toBeNull();
});
