// SYNTHETIC: policy semantics only, no real historical roster or release proof.
import type { ContextFact, ContextObservation, ReadinessRequest, StoredContextObservation } from '@dota/contracts';
import { registry as gameRegistry } from './game-fixtures.js';
export const start = '2024-01-01T12:00:00.000Z';
export const end = '2024-01-01T12:30:00.000Z';
export const snapshotAt = '2026-10-31T12:00:00.000Z';
export const knownPlayers = Array.from({ length: 10 }, (_, i) => String(9007199254741001n + BigInt(i)));
export const request: ReadinessRequest = { matchId: '9007199254740993', stage: 'pre_match', cutoffAt: start, snapshotAt,
  cohort: 'strict_verified_asof', requiredFacts: ['lineup','teams','patch'], assumedFacts: [] };
export const registry = gameRegistry;
export function evidence(fact: ContextFact, id = '1', overrides: Partial<ContextObservation> = {}): StoredContextObservation {
  return { id, matchId: request.matchId, fact, eventAt: '2024-01-01T11:00:00.000Z', knownAt: start,
    fetchedAt: snapshotAt, availability: 'verified_asof', earliestStage: ['heroes','first_pick_side','draft_order_version'].includes(fact.field) ? 'post_draft' : 'pre_match',
    provider: 'synthetic-archive', providerRecordId: null, evidenceRef: 'synthetic:dated-proof', adapterVersion: 'synthetic-v1', reviewState: 'accepted', ...overrides };
}
export function observations() {
  const lineup = knownPlayers.map((playerId, i) => ({ playerSlot: i < 5 ? i : i + 123, playerId }));
  return [evidence({ field: 'lineup', value: lineup }, '1'),
    evidence({ field: 'teams', value: { radiantTeamId: '11', direTeamId: '22' } }, '2'),
    evidence({ field: 'roles', value: lineup.map((row, i) => ({ ...row, rolePos: i % 5 + 1, basis: 'confirmed', confidence: 1 })) }, '3'),
    evidence({ field: 'heroes', value: lineup.map((row, i) => ({ playerSlot: row.playerSlot, heroId: i + 1 })) }, '4')];
}
export function retrospective() {
  return observations().map(row => ({ ...row, availability: 'retrospective_fact' as const, knownAt: null,
    eventAt: end, earliestStage: 'post_match' as const }));
}
