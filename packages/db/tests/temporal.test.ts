import { describe, expect, it } from 'vitest';
import { ContextObservationSchema, type ContextObservation, type StoredContextObservation } from '@dota/contracts';
import { isPriorCompletedMap, resolveContextAsOf, sideToScenarioSlot } from '../src/temporal.js';

const cutoffAt = '2024-01-01T12:00:00.000Z';
const query = { matchId: '9007199254740993', cutoffAt, stage: 'pre_match' as const };
const base: ContextObservation = {
  matchId: query.matchId, fact: { field: 'map_number', value: 2 },
  eventAt: '2024-01-01T11:00:00.000Z', knownAt: cutoffAt, fetchedAt: '2026-10-31T12:00:00.000Z',
  availability: 'verified_asof', earliestStage: 'pre_match', provider: 'synthetic-archive',
  providerRecordId: 'synthetic:map', evidenceRef: 'synthetic:dated-announcement', adapterVersion: 'test-v1', reviewState: 'accepted'
};
const observation = (overrides: Partial<ContextObservation> = {}, id = '1'): StoredContextObservation => ({ ...base, ...overrides, id });
const field = (rows: StoredContextObservation[], name = 'map_number', stage: 'pre_match' | 'post_draft' = 'pre_match') =>
  resolveContextAsOf(rows, { ...query, stage }).fields.find(item => item.field === name)!;

describe('strict point-in-time evidence', () => {
  it('permits dated archive evidence fetched later, including known_at exactly at cutoff', () => {
    expect(field([observation()])).toMatchObject({ status: 'available', fact: base.fact, observationIds: ['1'] });
  });
  it.each(['unknown', 'retrospective_fact', 'user_asserted_asof'] as const)('never upgrades %s to verified historical knowledge', availability => {
    expect(field([observation({ availability })])).toMatchObject({ fact: null, reasons: ['UNVERIFIED_AVAILABILITY'] });
  });
  it('does not substitute event or fetch time for absent known_at', () => {
    expect(field([observation({ knownAt: null, availability: 'retrospective_fact' })]).fact).toBeNull();
    expect(() => ContextObservationSchema.parse({ ...base, knownAt: null })).toThrow();
    expect(() => ContextObservationSchema.parse({ ...base, evidenceRef: ' ' })).toThrow();
  });
  it('blocks late knowledge and a future event independently', () => {
    expect(field([observation({ knownAt: '2024-01-01T12:00:00.001Z' })]).reasons).toEqual(['LATE_KNOWLEDGE']);
    expect(field([observation({ eventAt: '2024-01-01T12:00:00.001Z' })]).reasons).toEqual(['FUTURE_EVENT']);
  });
  it('preserves null and excludes rejected/unreviewed claims', () => {
    expect(field([observation({ fact: { field: 'map_number', value: null } })]).reasons).toEqual(['NULL_VALUE']);
    for (const reviewState of ['unverified', 'rejected'] as const)
      expect(field([observation({ reviewState })]).fact).toBeNull();
    expect(field([]).reasons).toEqual(['MISSING']);
  });
  it('reports contradictory proof instead of picking latest provider; row order does not matter', () => {
    const rows = [observation(), observation({ fact: { field: 'map_number', value: 3 } }, '9007199254740993')];
    expect(field(rows)).toEqual(field([...rows].reverse()));
    expect(field(rows)).toMatchObject({ fact: null, reasons: ['CONFLICT'], observationIds: ['1', '9007199254740993'] });
    expect(field([observation({ reviewState: 'conflict' })]).reasons).toEqual(['CONFLICT']);
    expect(field([observation(), observation({ fact: { field: 'map_number', value: null } }, '2')]).reasons).toEqual(['CONFLICT']);
  });
  it('future corrections and another map cannot change earlier resolved values', () => {
    const future = observation({ fact: { field: 'map_number', value: 3 }, knownAt: '2025-01-01T00:00:00.000Z' }, '2');
    const other = observation({ matchId: '777', fact: { field: 'map_number', value: 9 } }, '3');
    expect(field([observation(), future, other])).toEqual(field([observation()]));
  });
  it('keeps heroes, first pick and draft order out of pre-match even with early timestamps', () => {
    for (const fact of [
      { field: 'heroes', value: [{ playerSlot: 128, heroId: 1 }] },
      { field: 'first_pick_side', value: 'dire' },
      { field: 'draft_order_version', value: 'synthetic-historical-rule' }
    ] satisfies ContextObservation['fact'][]) {
      expect(() => ContextObservationSchema.parse({ ...base, fact })).toThrow();
      const row = observation({ fact, earliestStage: 'post_draft' });
      expect(field([row], fact.field).reasons).toEqual(['STAGE_UNAVAILABLE']);
      expect(field([row], fact.field, 'post_draft').fact).toEqual(fact);
      expect(field([observation({ fact, earliestStage: 'post_match' })], fact.field, 'post_draft').fact).toBeNull();
    }
  });
  it('stores pre-map series score without enabling between-map predictions', () => {
    const row = observation({ fact: { field: 'series_score_before', value: { radiant: 0, dire: 1 } } });
    expect(field([row], row.fact.field, 'post_draft').reasons).toEqual(['BETWEEN_MAPS_UNSUPPORTED']);
  });
  it('rejects outcomes, telemetry, invalid dates, extra keys and unsafe IDs at the boundary', () => {
    for (const change of [
      { fact: { field: 'radiant_win', value: true } }, { fact: { field: 'gpm', value: 700 } },
      { matchId: 9007199254740993 }, { matchId: '9223372036854775808' },
      { knownAt: '2024-13-40T00:00:00.000Z' }, { knownAt: '2027-01-01T00:00:00.000Z' },
      { eventAt: '2027-01-01T00:00:00.000Z' }, { surprise: true }
    ]) expect(ContextObservationSchema.safeParse({ ...base, ...change }).success).toBe(false);
  });
  it('uses native slots and preserves BIGINT IDs, missing IDs and independent role evidence', () => {
    const lineup = [{ playerSlot: 128, playerId: '9007199254740993' }, { playerSlot: 0, playerId: null }];
    const row = observation({ fact: { field: 'lineup', value: lineup } });
    expect(field([row], 'lineup').fact).toEqual(row.fact);
    expect(field([row], 'roles').fact).toBeNull();
    const duplicate = observation({ fact: { field: 'lineup', value: [...lineup, lineup[0]!] } });
    expect(() => field([duplicate], 'lineup')).toThrow();
    expect(ContextObservationSchema.safeParse({ ...base, fact: { field: 'lineup', value: [{ playerSlot: 5, playerId: null }] } }).success).toBe(false);
    const roles = observation({ fact: { field: 'roles', value: [{ playerSlot: 128, playerId: '9007199254740993', rolePos: 4, basis: 'estimated', confidence: 0.2 }] } });
    expect(field([roles], 'roles').fact).toEqual(roles.fact);
  });
  it('equivalent shuffled lineup observations are corroboration, not conflict', () => {
    const value = [{ playerSlot: 128, playerId: '10' }, { playerSlot: 0, playerId: '20' }];
    const rows = [observation({ fact: { field: 'lineup', value } }), observation({ fact: { field: 'lineup', value: [...value].reverse() } }, '2')];
    expect(field(rows, 'lineup')).toMatchObject({ status: 'available', observationIds: ['1', '2'] });
  });
  it('never assumes Team A is Radiant or first pick; swapping A/B preserves sides', () => {
    expect(sideToScenarioSlot('dire', 'A')).toBe('B');
    expect(sideToScenarioSlot('dire', 'B')).toBe('A');
    expect(sideToScenarioSlot('radiant', 'B')).toBe('B');
    expect(sideToScenarioSlot('dire', null)).toBeNull();
    expect(sideToScenarioSlot(null, 'A')).toBeNull();
  });
  it('requires strictly earlier start AND completed map for the history window', () => {
    expect(isPriorCompletedMap('2024-01-01T11:00:00.000Z', cutoffAt, cutoffAt)).toBe(true);
    expect(isPriorCompletedMap(cutoffAt, '2024-01-01T13:00:00.000Z', cutoffAt)).toBe(false);
    expect(isPriorCompletedMap('2024-01-01T11:00:00.000Z', '2024-01-01T12:00:00.001Z', cutoffAt)).toBe(false);
    expect(isPriorCompletedMap('2024-01-01T11:00:00.000Z', null, cutoffAt)).toBe(false);
    expect(isPriorCompletedMap('bad', cutoffAt, cutoffAt)).toBe(false);
    expect(isPriorCompletedMap(cutoffAt, '2024-01-01T11:00:00.000Z', cutoffAt)).toBe(false);
  });
});
