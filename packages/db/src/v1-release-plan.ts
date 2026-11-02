import { createHash } from 'node:crypto';
import { V1ReleasePlanRequestSchema, V1ReleaseCatalogueCaptureSchema, V1ReleaseCatalogueRowsSchema } from '@dota/contracts';
import { canonicalContextJson } from './temporal.js';
import { verifyV1Data } from './v1-data.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => sha(canonicalContextJson(value));

import { V1_RELEASE_QUALITY_POLICY } from '@dota/prediction';
export { V1_RELEASE_QUALITY_POLICY } from '@dota/prediction';

export function planV1Release(requestInput: unknown, catalogueInput: unknown, developmentInput: unknown, registeredAt: string) {
  const request = V1ReleasePlanRequestSchema.parse(requestInput);
  const catalogue = V1ReleaseCatalogueCaptureSchema.parse(catalogueInput);
  if (!Number.isFinite(Date.parse(registeredAt)) || new Date(registeredAt).toISOString() !== registeredAt) throw Error('release_clock_invalid');
  const testFrom = request.events.map(e => e.fromAt).sort()[0]!;
  if (registeredAt >= testFrom) throw Error('release_registration_too_late');
  if (catalogue.source.fetchedAt > registeredAt || request.events.some(e => e.tierDecision.reviewedAt > registeredAt)) throw Error('release_evidence_in_future');
  if (sha(catalogue.rawBody) !== catalogue.source.payloadSha256) throw Error('release_catalogue_payload_mismatch');
  const rows = V1ReleaseCatalogueRowsSchema.parse(JSON.parse(catalogue.rawBody));
  for (const event of request.events) {
    const matches = rows.filter(row => row.leagueid === event.leagueId);
    if (matches.length !== 1 || matches[0]!.name !== event.catalogueName || !['professional', 'premium'].includes(matches[0]!.tier ?? '')) {
      throw Error('release_event_binding_invalid');
    }
  }
  const development = verifyV1Data(developmentInput);
  if (development.source.request.snapshotAt > registeredAt || development.source.candidates.some(m => BigInt(m.startedAtUs) >= BigInt(Date.parse(testFrom)) * 1000n)) {
    throw Error('release_development_overlaps_test');
  }
  request.events.sort((a, b) => a.fromAt.localeCompare(b.fromAt) || a.eventKey.localeCompare(b.eventKey));
  const body = { schemaVersion: 1, format: 'v1-release-plan-v1', registeredAt, request,
    qualityPolicy: structuredClone(V1_RELEASE_QUALITY_POLICY),
    catalogueEvidence: catalogue.source, developmentFingerprint: development.fingerprint,
    reviewedDevelopmentMaps: development.source.candidates.map(m => m.matchId).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1),
    testFromAt: testFrom, evaluateNotBefore: request.snapshotAt, frozenExecutableRequiredBefore: testFrom,
    status: 'registered_not_evaluated', evaluation: null, sourceCollection: 'not_performed_by_planner',
    syntheticOnly: development.source.syntheticOnly, trainingReady: false, deployable: false, teamAWinProbability: null };
  return { ...body, fingerprint: hash(body) };
}

export function verifyV1ReleasePlan(saved: unknown, catalogue: unknown, development: unknown) {
  if (!saved || typeof saved !== 'object' || !('request' in saved) || !('registeredAt' in saved) || typeof saved.registeredAt !== 'string') throw Error('release_plan_invalid');
  const rebuilt = planV1Release(saved.request, catalogue, development, saved.registeredAt);
  if (canonicalContextJson(rebuilt) !== canonicalContextJson(saved)) throw Error('release_plan_replay_mismatch');
  return rebuilt;
}
