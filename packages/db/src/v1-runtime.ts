import { V1FeatureScenarioSchema, type ScenarioSnapshot, type V1FeatureHistory, type V1RuntimeRequest } from '@dota/contracts';
import { buildV1Features, createV1CandidateDiagnosticScorer } from '@dota/prediction';
import { resolveIdentity } from './identity.js';
import type { verifyV1RegistryArtifact } from './v1-registry.js';
export const runtimeUs = (time: string) => (BigInt(Date.parse(time)) * 1000n).toString();

export function runtimeTargetReasons(request: Pick<V1RuntimeRequest, 'targetScope'>, scenario: ScenarioSnapshot, now: string, providerLeagueId: string | null) {
  const reasons: string[] = [], input = scenario.input, scope = request.targetScope;
  if (!input.scheduledAt) reasons.push('TARGET_START_UNKNOWN');
  else if (input.scheduledAt <= now) reasons.push('TARGET_ALREADY_STARTED');
  if (!scope) reasons.push('TIER1_SCOPE_NOT_REVIEWED');
  else if (providerLeagueId !== scope.leagueId || !input.scheduledAt || input.scheduledAt < scope.fromAt || input.scheduledAt >= scope.until)
    reasons.push('TARGET_OUTSIDE_REVIEWED_TIER1_SCOPE');
  if ((input.context.mapNumber ?? 1) > 1 || (input.context.teamASeriesWinsBefore ?? 0) > 0 || (input.context.teamBSeriesWinsBefore ?? 0) > 0)
    reasons.push('BETWEEN_MAP_PREDICTION_UNSUPPORTED');
  if (scenario.recordedAt >= (input.scheduledAt ?? now)) reasons.push('LINEUP_NOT_SELECTED_BEFORE_START');
  return reasons;
}

/** Same numeric account only; nicknames, organizations and roles never resolve identities. */
export function runtimeFeatureScenario(history: V1FeatureHistory, scenario: ScenarioSnapshot, cutoffAt: string) {
  const evidence = history.identities.filter(i => i.fetchedAt <= cutoffAt &&
    (i.knownAt === null || i.knownAt <= cutoffAt) && (i.eventAt === null || i.eventAt <= cutoffAt));
  const members = [...scenario.input.lineupA, ...scenario.input.lineupB].map(p => {
    const accounts = [...new Set(evidence.filter(i => i.playerId === p.playerId).map(i => i.externalAccountId))]
      .filter(account => BigInt(account) < 4294967295n && resolveIdentity(evidence, account, null).playerId === p.playerId);
    return accounts.length === 1 ? { playerId: p.playerId, accountId: accounts[0]! } : null;
  });
  if (members.some(m => m === null)) return null;
  const parsed = V1FeatureScenarioSchema.safeParse({ schemaVersion: 1, cutoffAtUs: runtimeUs(cutoffAt), targetMatchId: null,
    teamA: members.slice(0, 5), teamB: members.slice(5), lineup: { basis: 'manual', source: 'owner-scenario:' + scenario.id,
      selectedAtUs: runtimeUs(scenario.recordedAt), revision: String(scenario.revision) } });
  return parsed.success ? parsed.data : null;
}

export function computeV1RuntimeFeatures(history: V1FeatureHistory, scenario: ScenarioSnapshot, cutoffAt: string,
  artifact: ReturnType<typeof verifyV1RegistryArtifact> | null) {
  if (history.syntheticOnly) throw Error('runtime_synthetic_forbidden');
  const input = runtimeFeatureScenario(history, scenario, cutoffAt);
  if (!input) return { features: null, probability: null, reasons: ['CURRENT_IDENTITIES_UNVERIFIED'] };
  const features = buildV1Features(history, input);
  const diagnostic = artifact ? createV1CandidateDiagnosticScorer(artifact.candidate, artifact.candidate.registration)(history, input) : null;
  return { features, probability: diagnostic?.evaluationProbability ?? null, reasons: features.reasons };
}
