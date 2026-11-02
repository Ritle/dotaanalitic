import { V1_DATA_PROFILE, type V1DataSource } from '@dota/contracts';
import { researchFixture } from './research-elo-fixtures.js';
export function v1Fixture(): V1DataSource {
  const { candidates, aliases, identities, identityRevision, code, syntheticOnly, request } = researchFixture();
  return { candidates, aliases, identities, identityRevision, code, syntheticOnly,
    request: { schemaVersion: 1, profile: V1_DATA_PROFILE, purpose: 'development_only',
      fromAt: request.fromAt, toAt: request.toAt, snapshotAt: request.snapshotAt, maxMaps: request.maxMaps } };
}
