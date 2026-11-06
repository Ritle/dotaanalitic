import { ResearchEvidenceFilesSchema } from '../../packages/contracts/dist/index.js';
import { canonicalContextJson } from '../../packages/db/dist/index.js';
import { reconcileEvaluationCandidates, selectEvaluationDetailBatch } from '../../packages/ingestion/dist/index.js';
import { bounded, sha, loadDiscoveryContext, verifyDiscoveryUnion } from './evaluation-discovery-files.mjs';
import { loadCapture } from './evaluation-detail-files.mjs';

export async function importSources(evidenceInput) {
  const evidence = ResearchEvidenceFilesSchema.parse(evidenceInput);
  const context = await loadDiscoveryContext(evidence.configPath);
  if (sha(context.configInput.bytes) !== evidence.configSha256) throw Error('import_source_binding');
  const union = await verifyDiscoveryUnion(context, evidence.unionPath, evidence.unionSha256), batches = [];
  for (const ref of evidence.batches) batches.push(await loadCapture(union.ledger, evidence.unionSha256, ref.directory, ref.manifestSha256));
  const count = Math.ceil(selectEvaluationDetailBatch(union.ledger, 0).allRequiredIds.length / 50);
  if (batches.length !== count || batches.some((b, i) => canonicalContextJson(b.report.selection) !==
    canonicalContextJson(selectEvaluationDetailBatch(union.ledger, i)))) throw Error('import_source_batches');
  const { data: plan } = await bounded(context.config.planPath, 4194304, context.config.planSha256);
  return { context, ledger: union.ledger, batches, evidence, syntheticOnly: plan.syntheticOnly === true };
}

// A diagnostic view of all batches, NOT a fabricated single-batch capture or an evaluation input.
// The existing pure reconciliation consumes only these three fields; no clocks or labels are rewritten.
export function reconcileImportSources(source, dataset) {
  const body = { format: 'managed-detail-assessment-set-v1', discoveryFingerprint: source.ledger.fingerprint,
    batches: source.evidence.batches, assessments: source.batches.flatMap(b => b.report.assessments) };
  const view = { ...body, fingerprint: sha(canonicalContextJson(body)) };
  return reconcileEvaluationCandidates(source.ledger, dataset, view);
}

export async function verifyImportDiagnostics(path, expectedSha, evidence) {
  const { data: saved } = await bounded(path, 67108864, expectedSha), { fingerprint, ...body } = saved;
  if (saved.format !== 'managed-import-diagnostics-v1' || fingerprint !== sha(canonicalContextJson(body)) ||
    canonicalContextJson(saved.evidence) !== canonicalContextJson(evidence)) throw Error('import_diagnostics_binding');
  const sources = await importSources(evidence), request = saved.dataset?.source?.request;
  if (saved.providerRequests !== 0 || saved.modelWrites !== 0 || saved.dataset?.source?.syntheticOnly !== sources.syntheticOnly ||
    request?.fromAt !== sources.context.warmupFromAt || request.toAt !== request.snapshotAt || request.maxMaps !== 5000)
    throw Error('import_diagnostics_binding');
  const replay = reconcileImportSources(sources, saved.dataset);
  if (canonicalContextJson(replay) !== canonicalContextJson(saved.report)) throw Error('import_diagnostics_replay');
  return saved;
}
