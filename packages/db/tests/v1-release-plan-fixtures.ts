import { createHash } from 'node:crypto';
import { prepareV1Data } from '../src/v1-data.js';
import { v1Fixture } from './v1-data-fixtures.js';
export const releaseDigest = (v: string) => createHash('sha256').update(v).digest('hex');
export function releasePlanFixture() {
  const development = prepareV1Data(v1Fixture());
  const rawBody = JSON.stringify([{ leagueid: 77, name: 'Synthetic main event', tier: 'professional' },
    { leagueid: '78', name: 'Synthetic qualifiers', tier: 'premium' }]);
  const catalogue = { rawBody, source: { provider: 'opendota', endpoint: '/leagues', fetchedAt: '2026-11-01T20:00:00.000Z',
    knownAt: null, payloadSha256: releaseDigest(rawBody) } };
  const request = { schemaVersion: 1, policyVersion: 'conditional-elo-tier1-release-v1', evaluationBasis: 'future_window_conditional_lineups',
    warmupFromAt: '2024-01-01T00:00:00.000Z', snapshotAt: '2026-12-02T00:00:00.000Z', maxInventoryMaps: 5000,
    catalogueSha256: releaseDigest(JSON.stringify(catalogue)), developmentDatasetSha256: releaseDigest(JSON.stringify(development)),
    events: [{ eventKey: 'synthetic-main-2026', name: 'Synthetic main event', provider: 'opendota', leagueId: '77',
      catalogueName: 'Synthetic main event', stage: 'main_event', fromAt: '2026-11-20T00:00:00.000Z', until: '2026-11-30T00:00:00.000Z',
      tierDecision: { basis: 'reviewed_event_scope', sourceUrl: 'https://example.com/synthetic', reviewedAt: '2026-11-01T21:00:00.000Z',
        rationale: 'Synthetic owner-reviewed main-event scope, not an actual tournament.' }, scheduleSourceUrl: 'https://example.com/synthetic-schedule' }] };
  return { development, catalogue, request, registeredAt: '2026-11-01T23:00:00.000Z' };
}
