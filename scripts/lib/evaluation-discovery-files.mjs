import { open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { EvaluationDiscoveryCommandSchema, EvaluationDiscoveryScopeSchema } from '../../packages/contracts/dist/index.js';
import { verifyResearchExecutionPlan, verifyV1ReleasePlan, canonicalContextJson } from '../../packages/db/dist/index.js';
import { buildEvaluationDiscoveryLedger, discoveryTraceStoppingReasons } from '../../packages/ingestion/dist/index.js';
export const sha = b => createHash('sha256').update(b).digest('hex');
export async function bounded(path, limit, expected) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) throw Error('discovery_file_limit');
    const buf = Buffer.alloc(limit + 1); let n = 0;
    while (n < buf.length) { const part = await file.read(buf, n, buf.length - n, null); if (!part.bytesRead) break; n += part.bytesRead; }
    if (n > limit) throw Error('discovery_file_limit');
    const bytes = buf.subarray(0, n);
    if (expected !== undefined && sha(bytes) !== expected) throw Error('discovery_file_sha_mismatch');
    return { bytes, data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } finally { await file.close(); }
}
export async function save(path, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > 33554432) throw Error('discovery_file_limit');
  const file = await open(path, 'wx');
  try { await file.writeFile(bytes, 'utf8'); } finally { await file.close(); }
  return { sha256: sha(bytes), bytes: Buffer.byteLength(bytes) };
}
export async function scopeFor(config) {
  const { data: saved } = await bounded(config.planPath, 4194304, config.planSha256);
  const aSha = config.kind === 'e1' ? saved?.request?.priorExportSha256 : saved?.request?.catalogueSha256;
  const bSha = config.kind === 'e1' ? saved?.request?.discoverySha256 : saved?.request?.developmentDatasetSha256;
  if (![aSha, bSha].every(v => /^[a-f0-9]{64}$/.test(v ?? ''))) throw Error('discovery_plan_source_sha_required');
  const { data: a } = await bounded(config.evidenceAPath, 67108864, aSha);
  const { data: b } = await bounded(config.evidenceBPath, 67108864, bSha);
  const plan = config.kind === 'e1' ? verifyResearchExecutionPlan(saved, a, b) : verifyV1ReleasePlan(saved, a, b);
  return EvaluationDiscoveryScopeSchema.parse({ schemaVersion: 1, kind: config.kind, planSha256: config.planSha256,
    planFingerprint: plan.fingerprint, maxMaps: 5000,
    snapshotAt: config.kind === 'e1' ? plan.request.evaluationNotBefore : plan.request.snapshotAt,
    windows: config.kind === 'e1' ? [{ fromAt: plan.request.holdoutFromAt, until: plan.request.holdoutUntil, leagueId: null }] :
      plan.request.events.map(e => ({ fromAt: e.fromAt, until: e.until, leagueId: e.leagueId })) });
}
export async function verifyRun(configInput, config, scope, root, expectedSha) {
  const { data: manifest } = await bounded(join(root, 'manifest.json'), 33554432, expectedSha);
  const { fingerprint, ...body } = manifest;
  if (manifest.format !== 'evaluation-discovery-run-v1' || sha(canonicalContextJson(body)) !== fingerprint ||
    manifest.configSha256 !== sha(configInput.bytes) || canonicalContextJson(manifest.ledger.scope) !== canonicalContextJson(scope) ||
    canonicalContextJson(manifest.ledger.limits) !== canonicalContextJson(config.limits) || !Array.isArray(manifest.receipts) || manifest.receipts.length > 20) throw Error('discovery_manifest_binding');
  const entries = [];
  await bounded(join(root, 'request.json'), 65536, manifest.request.sha256);
  for (const [i, ref] of manifest.receipts.entries()) {
    if (ref.path !== `receipt-${String(i).padStart(3, '0')}.json` || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '')) throw Error('discovery_receipt_path');
    entries.push((await bounded(join(root, ref.path), 16777216, ref.sha256)).data);
  }
  const rebuilt = buildEvaluationDiscoveryLedger(scope, entries, manifest.ledger.startedAt, manifest.ledger.completedAt, config.limits,
    discoveryTraceStoppingReasons(scope, entries, config.limits, manifest.ledger.startedAt));
  if (canonicalContextJson(rebuilt) !== canonicalContextJson(manifest.ledger)) throw Error('discovery_ledger_replay_mismatch');
  const allFiles = await readdir(root), expected = new Set(['request.json', 'manifest.json', ...manifest.receipts.map(r => r.path)]);
  if (allFiles.some(name => !expected.has(name))) throw Error('discovery_unmanifested_receipt');
  return { ledger: rebuilt, entries };
}

export async function loadDiscoveryContext(configPath) {
  const configInput = await bounded(configPath, 65536), config = EvaluationDiscoveryCommandSchema.parse(configInput.data);
  const scope = await scopeFor(config), { data: plan } = await bounded(config.planPath, 4194304, config.planSha256);
  return { configInput, config, scope, warmupFromAt: plan.request.warmupFromAt };
}

/** Rebuild the complete supplied-run union, not just its self-reported summary/fingerprint. */
export async function verifyDiscoveryUnion(context, path, expectedSha) {
  const { data: saved } = await bounded(path, 33554432, expectedSha);
  if (saved.format !== 'evaluation-discovery-union-v1' || !Array.isArray(saved.runs) || !saved.runs.length || saved.runs.length > 10 ||
    saved.runs.some(r => typeof r.directory !== 'string' || !/^[a-f0-9]{64}$/.test(r.manifestSha256 ?? '')) ||
    new Set(saved.runs.map(r => r.manifestSha256)).size !== saved.runs.length) throw Error('discovery_union_invalid');
  const refs = [...saved.runs].sort((a, b) => a.manifestSha256.localeCompare(b.manifestSha256));
  const { configInput, config, scope } = context, runs = [];
  for (const ref of refs) runs.push(await verifyRun(configInput, config, scope, resolve(ref.directory), ref.manifestSha256));
  const entries = runs.flatMap(r => r.entries).map((entry, i) => ({ ...entry, sequence: i }));
  const starts = runs.map(r => r.ledger.startedAt).sort(), ends = runs.map(r => r.ledger.completedAt).sort();
  const ledger = buildEvaluationDiscoveryLedger(scope, entries, starts[0], ends.at(-1), config.limits,
    [...new Set(runs.flatMap(r => r.ledger.stoppingReasons))].filter(r => !['INVENTORY_LIMIT', 'AFTER_EVALUATION_SNAPSHOT'].includes(r)));
  const body = { schemaVersion: 1, format: 'evaluation-discovery-union-v1', configSha256: sha(configInput.bytes), runs: refs, ledger,
    aggregation: 'all_supplied_runs_union_no_removal_or_conflict_overwrite', sourceHistoryCompleteness: 'only_explicitly_supplied_runs', metrics: null, deployable: false };
  const rebuilt = { ...body, fingerprint: sha(canonicalContextJson(body)) };
  if (canonicalContextJson(saved) !== canonicalContextJson(rebuilt)) throw Error('discovery_union_replay_mismatch');
  return rebuilt;
}
