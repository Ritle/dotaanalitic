import { createHash } from 'node:crypto';
import { V1ReleaseInventoryBodySchema, V1ReleaseInventorySchema, type V1ReleaseInventory } from '@dota/contracts';
import { canonicalContextJson } from './temporal.js';
import { prepareV1MapHistory } from './v1-data.js';
import { prepareV1PerMapFeatureHistory } from './v1-features.js';
const hash = (value: unknown) => createHash('sha256').update(canonicalContextJson(value)).digest('hex');
const order = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
export function releaseHistorySource(source: V1ReleaseInventory['source']) {
  return { ...source, request: { ...source.request, schemaVersion: 1, profile: 'pre-match-player-elo-data-v1', purpose: 'development_only' } };
}
export function freezeV1ReleaseInventory(input: unknown) {
  const body = V1ReleaseInventoryBodySchema.parse(input);
  const ids = body.source.candidates.map(m => m.matchId);
  if (new Set(ids).size !== ids.length || body.metadata.length !== ids.length ||
    new Set(body.metadata.map(m => m.matchId)).size !== ids.length || body.metadata.some(m => !ids.includes(m.matchId)))
    throw Error('release_metadata_inventory_mismatch');
  // Reuse the established evidence/identity rules, but never the development whole-series selection.
  const prepared = prepareV1MapHistory(releaseHistorySource(body.source));
  const { request: _compatibilityRequest, ...source } = prepared.source;
  body.source = { ...source, request: body.source.request };
  body.metadata.sort((a, b) => order(a.matchId, b.matchId));
  return { ...body, fingerprint: hash(body) };
}
export function verifyV1ReleaseInventory(input: unknown) {
  const parsed = V1ReleaseInventorySchema.parse(input), { fingerprint, ...body } = parsed;
  if (hash(body) !== fingerprint) throw Error('release_inventory_fingerprint_mismatch');
  const rebuilt = freezeV1ReleaseInventory(body);
  if (canonicalContextJson(rebuilt) !== canonicalContextJson(parsed)) throw Error('release_inventory_replay_mismatch');
  return rebuilt;
}
export function prepareReleaseHistory(inventory: unknown) {
  const verified = verifyV1ReleaseInventory(inventory), source = releaseHistorySource(verified.source);
  return { inventory: verified, assessments: prepareV1MapHistory(source).report.assessments,
    history: prepareV1PerMapFeatureHistory(source) };
}
