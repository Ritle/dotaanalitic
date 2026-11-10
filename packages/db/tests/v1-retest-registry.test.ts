import { expect, it } from 'vitest';
import { RetestRegistryEvidenceSchema, RetestRegistryMetadataSchema } from '@dota/contracts';
import { checkRetestRegistryBytes, retestRegistrySha } from '../src/v1-retest-registry-verifier.js';
import { retestRegistryFixture } from './v1-retest-registry-fixture.js';
it('requires bounded versioned bytes and exact SHA, not only a supplied summary', () => {
  const f = retestRegistryFixture(); expect(checkRetestRegistryBytes(f.evidence)).toEqual(f.evidence);
  for (const field of ['capsule','freeze','started','report','binding'] as const)
    expect(() => checkRetestRegistryBytes({ ...f.evidence, [field]: { ...f.evidence[field], text: f.evidence[field].text + 'é' } })).toThrow('retest_registry_bytes');
  expect(RetestRegistryEvidenceSchema.safeParse({ ...f.evidence, passed: true }).success).toBe(false);
});
it('keeps stage, retrospective basis and nonactivation explicit', () => {
  const { metadata } = retestRegistryFixture(); expect(RetestRegistryMetadataSchema.safeParse(metadata).success).toBe(true);
  for (const change of [{ stage: 'post_draft' }, { evaluationBasis: 'prospective' }, { isActive: true }, { syntheticOnly: true }, { qualityDecision: 'failed' }])
    expect(RetestRegistryMetadataSchema.safeParse({ ...metadata, ...change }).success).toBe(false);
});
it('bounds UTF-8 bytes rather than accepting a smaller JavaScript character count', () => {
  const { evidence } = retestRegistryFixture(), text = 'é'.repeat(40000);
  expect(() => checkRetestRegistryBytes({ ...evidence, started: { text, sha256: retestRegistrySha(text) } })).toThrow('retest_registry_bytes');
});
