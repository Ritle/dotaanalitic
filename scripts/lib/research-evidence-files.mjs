import { ResearchEvidenceFilesSchema } from '../../packages/contracts/dist/index.js';
import { bounded, loadDiscoveryContext, verifyDiscoveryUnion, sha } from './evaluation-discovery-files.mjs';
import { loadCapture } from './evaluation-detail-files.mjs';
import { selectEvaluationDetailBatch } from '../../packages/ingestion/dist/index.js';

export async function loadResearchEvidence(input, planSha) {
  const files = ResearchEvidenceFilesSchema.parse(input);
  const context = await loadDiscoveryContext(files.configPath);
  if (sha(context.configInput.bytes) !== files.configSha256 || context.config.kind !== 'e1' || context.config.planSha256 !== planSha)
    throw Error('execution_evidence_scope');
  const union = await verifyDiscoveryUnion(context, files.unionPath, files.unionSha256);
  if (new Set(files.batches.map(b => b.manifestSha256)).size !== files.batches.length) throw Error('execution_evidence_batches');
  const batches = [];
  for (const b of files.batches) {
    const capture = await loadCapture(union.ledger, files.unionSha256, b.directory, b.manifestSha256);
    batches.push(capture.report);
  }
  const count = Math.ceil(selectEvaluationDetailBatch(union.ledger, 0).allRequiredIds.length / 50);
  if (batches.length !== count || new Set(batches.map(b => b.selection.batchIndex)).size !== count ||
    batches.some(b => b.selection.batchIndex >= count)) throw Error('execution_evidence_batches');
  if (union.ledger.completedAt > context.scope.snapshotAt || batches.some(b => b.completedAt > context.scope.snapshotAt))
    throw Error('execution_evidence_horizon');
  return { files, ledger: union.ledger, batches };
}

export async function readResearchEvidence(path, digest, planSha) {
  const { data } = await bounded(path, 65536, digest);
  return loadResearchEvidence(data, planSha);
}
