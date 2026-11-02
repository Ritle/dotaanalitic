import { expect, it } from 'vitest';
import { V1RegistryTransitionSchema } from '@dota/contracts';
import { registryFixture } from './v1-registry-fixtures.js';
import { registryHash, registrySha, verifyV1RegistryArtifact, verifyV1RegistryRelease } from '../src/v1-registry.js';
const seal = <T extends { fingerprint: string }>(r: T) => { const { fingerprint: _, ...body } = r; return { ...body, fingerprint: registryHash(body) }; };
it('verifies exact fixed-policy artifact bytes and a bound release contract without returning a forecast', () => {
  const f = registryFixture();
  expect(verifyV1RegistryArtifact(f.bytes).candidate.isActive).toBe(false);
  expect(verifyV1RegistryRelease(f.artifact, f.journal, '2026-11-02T00:00:00.000Z').report.teamAWinProbability).toBeNull();
});
it('rejects corrupt bytes, substituted plans, synthetic provenance and missing kernel hashes', () => {
  const f = registryFixture();
  expect(() => verifyV1RegistryArtifact({ ...f.bytes, candidateText: f.bytes.candidateText + ' ' })).toThrow('registry_artifact_hash');
  for (const patch of [{ syntheticOnly: true }, { candidateFingerprint: '0'.repeat(64) }, { code: [{ path: 'other.js', sha256: '0'.repeat(64) }] }]) {
    const freeze = seal({ ...f.freeze, ...patch }), text = JSON.stringify(freeze);
    expect(() => verifyV1RegistryArtifact({ ...f.bytes, freezeText: text, freezeSha256: registrySha(text) })).toThrow();
  }
});
it('rejects unpassed, synthetic, legacy, substituted and early release contracts', () => {
  const f = registryFixture();
  for (const patch of [{ releaseGatePassed: false }, { freezeSha256: '0'.repeat(64) }, { candidateFingerprint: '0'.repeat(64) },
    { evaluation: { ...f.journal.report.evaluation, syntheticOnly: true } },
    { format: 'v1-release-evaluation-v1', executableFreezeComplete: false, releaseGatePassed: false }]) {
    const journal = seal({ ...f.journal, report: seal({ ...f.journal.report, ...patch }) });
    expect(() => verifyV1RegistryRelease(f.artifact, journal, '2026-11-02T00:00:00.000Z')).toThrow();
  }
  expect(() => verifyV1RegistryRelease(f.artifact, f.journal, f.plan.registeredAt)).toThrow('registry_time_gate');
});
it('requires explicit CAS, request identity, reason and operation-specific release evidence', () => {
  const f = registryFixture(); expect(V1RegistryTransitionSchema.parse(f.request)).toEqual(f.request);
  for (const patch of [{ release: null }, { modelId: null }, { reason: '' }, { expectedCurrentId: f.request.modelId },
    { action: 'deactivate' }, { stage: 'post_draft' }]) expect(() => V1RegistryTransitionSchema.parse({ ...f.request, ...patch })).toThrow();
});
