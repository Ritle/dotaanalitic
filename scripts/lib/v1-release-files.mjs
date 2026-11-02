import { readFile, readdir } from 'node:fs/promises';
import { V1ReleaseFilesSchema } from '../../packages/contracts/dist/index.js';
import { verifyV1ReleasePlan, verifyRegisteredV1Candidate, verifyV1ExecutableFreeze } from '../../packages/db/dist/index.js';
import { bounded, loadDiscoveryContext, verifyDiscoveryUnion, sha } from './evaluation-discovery-files.mjs';
import { candidateCodeManifest } from './v1-candidate-files.mjs';
import { loadCapture } from './evaluation-detail-files.mjs';
export async function readReleaseFiles(path, digest) {
  const input = await bounded(path, 65536, digest), files = V1ReleaseFilesSchema.parse(input.data);
  const { data: plan } = await bounded(files.planPath, 4194304, files.planSha256);
  return { files, plan, filesSha256: digest };
}
export async function verifyReleaseContext(context) {
  const { files, plan } = context;
  const { data: catalogue } = await bounded(files.cataloguePath, 16777216, plan.request.catalogueSha256);
  const { data: development } = await bounded(files.developmentPath, 67108864, plan.request.developmentDatasetSha256);
  const verifiedPlan = verifyV1ReleasePlan(plan, catalogue, development);
  const { data: saved } = await bounded(files.candidatePath, 4194304, files.candidateSha256);
  const candidate = verifyRegisteredV1Candidate(saved, plan, catalogue, development, files.planSha256, await candidateCodeManifest());
  const freeze = files.freeze ? verifyV1ExecutableFreeze((await bounded(files.freeze.path, 4194304, files.freeze.sha256)).data,
    verifiedPlan, candidate, files.planSha256, files.candidateSha256, await releaseExecutionCode(), await releaseRuntime()) : undefined;
  if (freeze && freeze.registeredAt > new Date().toISOString()) throw Error('freeze_in_future');
  return { ...context, plan: verifiedPlan, candidate, freeze };
}
export async function loadReleaseEvidence(context) {
  const { files, plan } = context, evidence = files.evidence;
  const discovery = await loadDiscoveryContext(evidence.configPath);
  if (sha(discovery.configInput.bytes) !== evidence.configSha256 || discovery.config.kind !== 'v1' ||
    discovery.config.planSha256 !== files.planSha256 || discovery.scope.planFingerprint !== plan.fingerprint) throw Error('release_evidence_scope');
  const union = await verifyDiscoveryUnion(discovery, evidence.unionPath, evidence.unionSha256);
  if (new Set(evidence.batches.map(b => b.manifestSha256)).size !== evidence.batches.length) throw Error('release_detail_batches');
  const batches = [];
  for (const ref of evidence.batches) batches.push(await loadCapture(union.ledger, evidence.unionSha256, ref.directory, ref.manifestSha256));
  return { ledger: union.ledger, batches };
}
export async function releaseExecutionCode(root = new URL('../../', import.meta.url)) {
  const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json',
    ...['contracts', 'analytics', 'prediction', 'db', 'ingestion'].map(n => `packages/${n}/package.json`),
    ...['api', 'web', 'worker'].map(n => `apps/${n}/package.json`)];
  async function collect(directory) {
    for (const entry of await readdir(new URL(directory + '/', root), { withFileTypes: true })) {
      const path = directory + '/' + entry.name;
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && /\.(?:mjs|js|sql)$/.test(entry.name)) files.push(path);
    }
  }
  for (const directory of ['scripts', 'packages/analytics/dist', 'packages/contracts/dist', 'packages/prediction/dist',
    'packages/db/dist', 'packages/ingestion/dist', 'packages/db/migrations']) await collect(directory);
  return Promise.all(files.sort().map(async path => ({ path, sha256: sha(await readFile(new URL(path, root))) })));
}
export async function releaseRuntime() {
  return { node: process.version, platform: process.platform, arch: process.arch, nodeBinarySha256: sha(await readFile(process.execPath)) };
}
