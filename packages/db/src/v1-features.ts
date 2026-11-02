import { V1FeatureHistorySchema, V1_FEATURE_PROFILE, type V1FeatureScenario } from '@dota/contracts';
import { createV1FeatureBuilder } from '@dota/prediction';
import { verifyV1Data, prepareV1MapHistory } from './v1-data.js';

const us = (time: string) => (BigInt(Date.parse(time)) * 1000n).toString();

/** Replay the frozen evidence/eligibility boundary; never trust an arbitrary saved report. */
export function prepareV1FeatureHistory(input: unknown) {
  return normalizedHistory(verifyV1Data(input));
}

export function prepareV1PerMapFeatureHistory(source: unknown) {
  return normalizedHistory(prepareV1MapHistory(source));
}

function normalizedHistory(dataset: Pick<ReturnType<typeof verifyV1Data>, 'source' | 'report' | 'fingerprint'>) {
  const byId = new Map(dataset.source.candidates.map(m => [m.matchId, m]));
  return V1FeatureHistorySchema.parse({
    schemaVersion: 1, profile: V1_FEATURE_PROFILE, sourceFingerprint: dataset.fingerprint,
    identityRevision: dataset.source.identityRevision, snapshotAtUs: us(dataset.source.request.snapshotAt),
    warmupFromAtUs: us(dataset.source.request.fromAt), syntheticOnly: dataset.source.syntheticOnly,
    identities: dataset.source.identities,
    maps: dataset.report.examples.map(example => {
      const map = byId.get(example.matchId)!;
      if (map.outcome.status !== 'verified') throw Error('v1_feature_outcome_unverified');
      const member = (playerId: string, slot: number) => {
        const accountId = map.players.find(p => p.playerSlot === slot)?.sourceAccountId;
        if (!accountId) throw Error('v1_feature_account_missing');
        return { playerId, accountId };
      };
      return { matchId: map.matchId, seriesKey: example.seriesKey, startedAtUs: map.startedAtUs,
        completedAtUs: example.label.completedAtUs, isPro: true,
        teamA: example.inputs.teamAPlayerIds.map((id, index) => member(id, index)),
        teamB: example.inputs.teamBPlayerIds.map((id, index) => member(id, 128 + index)),
        teamAWon: example.label.teamAWon, outcomeReceiptId: map.outcome.outcomeReceiptId,
        payloadSha256: map.outcome.sourceEvidence.payloadSha256,
        fetchedAtUs: us(map.outcome.sourceEvidence.receiptFetchedAt), labelVerifiedAtUs: us(map.outcome.labelVerifiedAt),
        factClocks: map.facts };
    })
  });
}

/** Development features only. No holdout scoring, labels in output, fitted candidate or publication. */
export function buildV1DevelopmentFeatures(input: unknown) {
  const history = prepareV1FeatureHistory(input), builder = createV1FeatureBuilder(history);
  const rows = history.maps.map(map => {
    const scenario: V1FeatureScenario = { schemaVersion: 1, cutoffAtUs: map.startedAtUs, targetMatchId: map.matchId,
      teamA: map.teamA, teamB: map.teamB, lineup: { basis: 'actual_lineup_reconstructed',
        source: 'verified-map-receipt:' + map.outcomeReceiptId, selectedAtUs: map.fetchedAtUs,
        revision: history.sourceFingerprint } };
    return { matchId: map.matchId, seriesKey: map.seriesKey, result: builder(scenario) };
  });
  return { schemaVersion: 1, format: 'v1-development-features-v1', featureSchemaVersion: V1_FEATURE_PROFILE,
    sourceFingerprint: history.sourceFingerprint, summary: { maps: rows.length,
      featureReady: rows.filter(r => r.result.status === 'ready').length,
      unavailable: rows.filter(r => r.result.status === 'unavailable').length }, rows,
    syntheticOnly: history.syntheticOnly, evaluation: 'not_performed', deployable: false, teamAWinProbability: null };
}
