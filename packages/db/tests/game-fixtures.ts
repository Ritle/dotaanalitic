// SYNTHETIC: arbitrary patch/rules/teams. Not a real historical Dota ruleset.
import type { ContextFact, ContextObservation, GameContextRequest, GameRegistry, StoredContextObservation } from '@dota/contracts';
export const cutoffAt = '2024-01-01T12:00:00.000Z';
export const before = '2024-01-01T00:00:00.000Z';
export const after = '2024-01-02T00:00:00.000Z';
export const query: GameContextRequest = { matchId: '9007199254740993', cutoffAt, stage: 'post_draft', teamAId: '11', teamBId: '22' };
export const clocks = { eventAt: before, knownAt: before, fetchedAt: '2026-10-31T12:00:00.000Z',
  source: 'synthetic-archive', evidenceRef: 'synthetic:dated-proof', reviewState: 'accepted' as const };
export function registry(): GameRegistry {
  return { revision: '3', patches: [{ ...clocks, id: '1', patchId: '1', releasedAt: before, coverageUntil: after }],
    draftRules: [{ ...clocks, id: '2', patchId: '1', gameMode: 2, lobbyType: 1, version: 'synthetic-rule-v1' }],
    heroRules: [{ ...clocks, id: '3', heroId: 1, patchId: '1', leagueId: '100', allowed: true, validFrom: before, validTo: after }] };
}
export function observation(fact: ContextFact, id = '1'): StoredContextObservation {
  return { id, matchId: query.matchId, fact, eventAt: clocks.eventAt, knownAt: clocks.knownAt, fetchedAt: clocks.fetchedAt,
    availability: 'verified_asof', earliestStage: ['heroes', 'first_pick_side', 'draft_order_version'].includes(fact.field) ? 'post_draft' : 'pre_match',
    provider: clocks.source, providerRecordId: null, evidenceRef: clocks.evidenceRef, adapterVersion: 'synthetic-v1', reviewState: 'accepted' };
}
export function observations(): StoredContextObservation[] {
  const facts: ContextFact[] = [
    { field: 'teams', value: { radiantTeamId: '22', direTeamId: '11' } },
    { field: 'league_id', value: '100' }, { field: 'game_mode', value: 2 }, { field: 'lobby_type', value: 1 },
    { field: 'map_number', value: 2 }, { field: 'series_id', value: '123e4567-e89b-42d3-a456-426614174000' },
    { field: 'first_pick_side', value: 'dire' }, { field: 'draft_order_version', value: 'synthetic-rule-v1' },
    { field: 'heroes', value: Array.from({ length: 10 }, (_, i) => ({ heroId: i + 1, playerSlot: i < 5 ? i : i + 123 })) }
  ];
  return facts.map((fact, i) => observation(fact, String(i + 1)));
}
export const withoutId = ({ id: _id, ...row }: StoredContextObservation): ContextObservation => row;
