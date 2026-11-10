import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RetestRegistryEvidenceSchema, RetestRegistryMetadataSchema, RETEST_REGISTRY_LIMITS } from '../../packages/contracts/dist/v1-retest-registry.js';
import { verifyRetestCapsule, verifyRetestFreeze, retestRegistryBinding } from './v1-retest-execution.mjs';
import { releaseRuntime } from './v1-release-files.mjs';
import { sha } from './v1-historical-protocol.mjs';
import { hash } from './v1-historical-collection.mjs';

const fail = reason => { throw Error('retest_registry_' + reason); };
const extensions = { 'packages/contracts/dist/index.js': "export * from './v1-retest-registry.js';\nexport * from './v1-retest-activation.js';\n",
  'packages/db/dist/index.js': "export * from './v1-retest-registry-repository.js';\nexport * from './v1-retest-activation-repository.js';\nexport * from './v1-model-runtime.js';\n" };
/** Scored code must match, except exact additive exports and two reviewed orchestration dispatch changes. */
export async function verifyRetestRegistryCode(code, root = new URL('../../', import.meta.url)) {
  const base = await realpath(fileURLToPath(root));
  const approvals = JSON.parse(await readFile(new URL('./v1-retest-runtime-compatibility.json', import.meta.url), 'utf8'));
  const orchestration = ['packages/db/dist/v1-runtime-repository.js', 'packages/db/dist/schedule-page-runtime.js'];
  if (approvals.schemaVersion !== 1 || approvals.changes.some(c => !orchestration.includes(c.path))) fail('compatibility_manifest');
  for (const item of code) {
    const path = resolve(base, item.path);
    if (!path.startsWith(base + sep) || await realpath(path) !== path) fail('code_path');
    const bytes = await readFile(path);
    if (sha(bytes) === item.sha256) continue;
    if (approvals.changes.some(c => c.path === item.path && c.before === item.sha256 && c.after === sha(bytes))) continue;
    const extension = extensions[item.path], text = bytes.toString('utf8');
    const suffixes = extension ? [extension, extension.split('\n')[0] + '\n'] : [];
    if (!suffixes.some(suffix => text.endsWith(suffix) && sha(text.slice(0, -suffix.length)) === item.sha256)) fail('code_changed');
  }
}
export async function verifyRetestRegistryEvidence(input) {
  const evidence = RetestRegistryEvidenceSchema.parse(input);
  for (const [key, max] of Object.entries(RETEST_REGISTRY_LIMITS)) {
    if (Buffer.byteLength(evidence[key].text) > max || sha(evidence[key].text) !== evidence[key].sha256) fail('bytes');
  }
  const report = JSON.parse(evidence.report.text);
  if (report.syntheticOnly) fail('synthetic_forbidden');
  if (report.qualityDecision !== 'passed' || report.releaseGatePassed !== true) fail('quality_not_passed');
  const context = verifyRetestCapsule(JSON.parse(evidence.capsule.text));
  if (context.protocol.syntheticOnly || context.dataset.source.syntheticOnly) fail('synthetic_forbidden');
  const frozen = JSON.parse(evidence.freeze.text), start = JSON.parse(evidence.started.text);
  await verifyRetestRegistryCode(frozen.code);
  const freeze = verifyRetestFreeze(frozen, context, evidence.capsule.sha256, frozen.code, await releaseRuntime());
  const now = new Date().toISOString();
  if (freeze.registeredAt > now || start.startedAt > now || hash(start) !== hash(report.firstScoring)) fail('time_or_start_binding');
  // Full trusted replay, not acceptance of a supplied passed flag or summary.
  const binding = retestRegistryBinding(context, freeze, evidence.freeze.sha256, report);
  if (hash(binding) !== hash(JSON.parse(evidence.binding.text))) fail('binding');
  if (!binding.eligibleForActivation || report.qualityDecision !== 'passed' || !report.releaseGatePassed) fail('quality_not_passed');
  const p = context.protocol;
  return RetestRegistryMetadataSchema.parse({ schemaVersion: 1, stage: 'pre_match', algorithm: 'fixed_player_mean_elo',
    featureSchemaVersion: p.qualityPolicy.model.featureProfile, evaluationBasis: report.evaluationBasis, qualityDecision: 'passed',
    protocolFingerprint: p.fingerprint, datasetFingerprint: context.dataset.fingerprint, candidateFingerprint: freeze.candidateFingerprint,
    freezeFingerprint: freeze.fingerprint, reportFingerprint: report.fingerprint, qualityPolicySha256: freeze.qualityPolicySha256,
    previousReportSha256: freeze.previousReportSha256, scorerCodeFingerprint: hash(freeze.code), registeredAt: freeze.registeredAt,
    firstScoringAt: start.startedAt, warmupFromAt: p.request.warmupFromAt,
    testFromAt: p.request.events.map(e => e.fromAt).sort()[0], testUntil: p.request.events.map(e => e.until).sort().at(-1),
    scoredMaps: report.rows.length, scoredSeries: report.metricDiagnostic.coverage.scoredSeries, metrics: report.metricDiagnostic.metrics,
    runtime: freeze.runtime, syntheticOnly: false, isActive: false, deployable: false });
}
