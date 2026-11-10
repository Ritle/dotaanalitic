import { createHash } from 'node:crypto';
import { RetestRegistryEvidenceSchema, RetestRegistryMetadataSchema, RETEST_REGISTRY_LIMITS,
  type RetestRegistryEvidence } from '@dota/contracts';
export const retestRegistrySha = (text: string) => createHash('sha256').update(text).digest('hex');
export function checkRetestRegistryBytes(input: unknown) {
  const evidence = RetestRegistryEvidenceSchema.parse(input);
  for (const [key, limit] of Object.entries(RETEST_REGISTRY_LIMITS)) {
    const item = evidence[key as keyof typeof RETEST_REGISTRY_LIMITS];
    if (Buffer.byteLength(item.text) > limit || retestRegistrySha(item.text) !== item.sha256) throw Error('retest_registry_bytes');
  }
  return evidence;
}
/** Fixed, trusted repository module. Never import code from an artifact path or accept a caller-supplied verifier. */
export async function verifyRetestRegistryEvidence(input: RetestRegistryEvidence) {
  const moduleUrl = new URL('../../../scripts/lib/v1-retest-registry-verifier.mjs', import.meta.url);
  const verifier: { verifyRetestRegistryEvidence: (value: unknown) => Promise<unknown> } = await import(moduleUrl.href);
  return RetestRegistryMetadataSchema.parse(await verifier.verifyRetestRegistryEvidence(input));
}
