import { mkdir, readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ManagedImportManifestSchema, V1ReleaseFilesSchema } from '../../packages/contracts/dist/index.js';
import { canonicalContextJson } from '../../packages/db/dist/index.js';
import { bounded, sha, save } from './evaluation-discovery-files.mjs';
import { detailCollectionManager } from './v1-detail-collection.mjs';
import { verifyImportDiagnostics } from './v1-import-diagnostics.mjs';

const fail = code => { throw Error(code); }, digest = /^[a-f0-9]{64}$/;
const hash = value => sha(canonicalContextJson(value));
const read = async (path, expected) => (await bounded(path, 33554432, expected)).data;
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const fileSha = async path => sha(await readFile(path));
const same = (a, b) => canonicalContextJson(a) === canonicalContextJson(b);
const output = (status, extra = {}) => ({ ...extra, status, providerRequests: 0, modelWrites: 0, readyForEvaluation: false, teamAWinProbability: null });
const key = (batch, attempt) => String(batch).padStart(2, '0') + '-' + String(attempt).padStart(2, '0');
async function directory(path, create = false) {
  if (create && !await exists(path)) await mkdir(path);
  if (await realpath(path) !== path) fail('import_path');
  return path;
}
async function tree(path) {
  const files = [];
  for (const name of (await readdir(path)).sort()) {
    const file = join(path, name), stat = await lstat(file);
    if (stat.isSymbolicLink()) fail('import_path');
    if (stat.isDirectory()) for (const entry of await tree(file)) files.push({ ...entry, path: name + '/' + entry.path });
    else if (stat.isFile()) files.push({ path: name, sha256: await fileSha(file) });
    else fail('import_path');
  }
  return files;
}
async function localReconcile(args) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../reconcile-v1-import.mjs', import.meta.url)), ...args],
      { windowsHide: true, timeout: 300000, maxBuffer: 1048576 });
    return JSON.parse(stdout);
  } catch (e) {
    let stage = 'process';
    try { const saved = JSON.parse(e.stderr); if (['input', 'sources', 'database', 'diagnostics', 'output'].includes(saved.stage)) stage = saved.stage; } catch {}
    throw Error('import_reconciliation_failed', { cause: { stage } });
  }
}

/** Operator ledger around the unchanged captured-byte importer; no identity inference or model writes. */
export function importCollectionManager({ details = detailCollectionManager(), reconcile = localReconcile,
  verifyDiagnostics = verifyImportDiagnostics } = {}) {
  async function workspace(ctx, create) {
    const path = join(ctx.detailRoot, 'imports');
    if (!create && !await exists(path)) return null;
    await directory(path, create);
    for (const name of ['attempts', 'runs', 'reviews', 'exports']) await directory(join(path, name), create);
    return path;
  }
  async function verifyArtifact(ctx, row, expected) {
    const path = await directory(join(row.path, 'import'));
    const manifestSha256 = expected ?? await fileSha(join(path, 'manifest.json'));
    const manifest = ManagedImportManifestSchema.parse(await read(join(path, 'manifest.json'), manifestSha256));
    const { fingerprint, ...body } = manifest;
    const ref = ctx.evidence.batches[row.intent.batchIndex], selection = ctx.selections[row.intent.batchIndex];
    const capture = await read(join(ref.directory, 'manifest.json'), ref.manifestSha256);
    if (fingerprint !== hash(body) || manifest.unionSha256 !== ctx.evidence.unionSha256 || manifest.captureSha256 !== ref.manifestSha256 ||
      !same(manifest.results.map(r => r.matchId), selection.selectedIds) || manifest.completedAt < row.intent.createdAt)
      fail('import_artifact_binding');
    if (!same(await read(join(path, 'request.json')), { unionSha256: ctx.evidence.unionSha256, captureSha256: ref.manifestSha256, selection }))
      fail('import_artifact_binding');
    for (const [i, result] of manifest.results.entries()) {
      const assessment = capture.assessment.assessments[i];
      if (!same(result, await read(join(path, 'result-' + result.matchId + '.json'))) ||
        (assessment.sourceEligible ? result.status === 'not_importable' :
          result.status !== 'not_importable' || !same(result.reasons, assessment.reasons))) fail('import_artifact_binding');
    }
    const allowed = ['manifest.json', 'request.json', ...selection.selectedIds.map(id => 'result-' + id + '.json')].sort();
    if (!same((await readdir(path)).sort(), allowed)) fail('import_artifact_binding');
    return { manifestSha256, counts: Object.fromEntries(['accepted', 'partial', 'conflict', 'quarantined', 'not_importable', 'import_failed']
      .map(status => [status, manifest.results.filter(r => r.status === status).length])) };
  }
  async function inventory(ctx, root) {
    if (!root) return [];
    const names = (await readdir(join(root, 'runs'))).sort(), markers = (await readdir(join(root, 'attempts'))).sort(), rows = [];
    if (!same(markers, names.map(n => n + '.json'))) fail('import_inventory');
    const last = new Map();
    for (const name of names) {
      if (!/^\d{2}-(?:0[1-9]|10)$/.test(name)) fail('import_inventory');
      const path = await directory(join(root, 'runs', name)), marker = join(root, 'attempts', name + '.json');
      const intentSha256 = await fileSha(marker), intent = await read(join(path, 'intent.json'), intentSha256);
      const prior = last.get(intent.batchIndex);
      if (name !== key(intent.batchIndex, intent.attempt) || intent.batchIndex < 0 || intent.batchIndex >= ctx.selections.length ||
        intent.attempt !== (prior?.intent.attempt ?? 0) + 1 || intent.evidenceSha256 !== hash(ctx.evidence) ||
        intent.previousAttemptSha256 !== (prior?.treeSha256 ?? null)) fail('import_inventory');
      let receipt = await exists(join(path, 'result.json')) ? await read(join(path, 'result.json')) : null;
      if (receipt && (receipt.intentSha256 !== intentSha256 || !['recorded', 'failed'].includes(receipt.status))) fail('import_inventory');
      const failurePreserved = receipt?.status === 'failed';
      if (await exists(join(path, 'recovery.json'))) {
        const recovered = await read(join(path, 'recovery.json'));
        if (!failurePreserved || recovered.failedResultSha256 !== await fileSha(join(path, 'result.json')) ||
          recovered.intentSha256 !== intentSha256 || recovered.status !== 'recorded') fail('import_inventory');
        receipt = recovered;
      }
      const row = { path, intent, intentSha256, receipt, failurePreserved };
      if (receipt?.status === 'recorded') {
        if (!digest.test(receipt.manifestSha256 ?? '')) fail('import_inventory');
        row.verified = await verifyArtifact(ctx, row, receipt.manifestSha256);
      }
      row.treeSha256 = hash(await tree(path)); rows.push(row); last.set(intent.batchIndex, row);
    }
    return rows;
  }
  const latest = rows => [...new Map(rows.map(r => [r.intent.batchIndex, r])).values()];
  const stamp = rows => hash(rows.map(r => ({ batchIndex: r.intent.batchIndex, attempt: r.intent.attempt, treeSha256: r.treeSha256 })));
  function complete(ctx, rows) {
    if (latest(rows).length !== ctx.selections.length || latest(rows).some(r => r.receipt?.status !== 'recorded')) fail('import_incomplete');
  }
  function index(ctx, batch, attempt) {
    if (!Number.isInteger(batch) || batch < 0 || batch >= ctx.selections.length || !Number.isInteger(attempt) || attempt < 1 || attempt > 10)
      fail('import_input');
  }
  async function finish(ctx, row, recovered, expected) {
    const checked = await verifyArtifact(ctx, row, expected);
    const receipt = { status: 'recorded', intentSha256: row.intentSha256, ...checked, recovered, recordedAt: ctx.now() };
    if (row.receipt?.status === 'failed') {
      receipt.failedResultSha256 = await fileSha(join(row.path, 'result.json')); await save(join(row.path, 'recovery.json'), receipt);
    } else await save(join(row.path, 'result.json'), receipt);
    return output('import_recorded', receipt);
  }
  async function status(root, collectionSha, unionSha) {
    return details.withDetails(root, collectionSha, unionSha, async ctx => {
      const rows = await inventory(ctx, await workspace(ctx, false));
      return output('import_status', { currentDiscovery: ctx.currentDiscovery, requiredBatches: ctx.selections.length, attempts: rows.map(r => ({
        batchIndex: r.intent.batchIndex, attempt: r.intent.attempt, status: r.receipt?.status ?? 'interrupted',
        failurePreserved: r.failurePreserved, counts: r.verified?.counts ?? null })),
        missing: ctx.selections.filter(s => !latest(rows).some(r => r.intent.batchIndex === s.batchIndex && r.receipt?.status === 'recorded')).map(s => s.batchIndex) });
    }, { allowStale: true });
  }
  async function batch(root, collectionSha, unionSha, batchIndex, attempt) {
    return details.withDetails(root, collectionSha, unionSha, async ctx => {
      index(ctx, batchIndex, attempt);
      const path = await workspace(ctx, true), rows = await inventory(ctx, path);
      const prior = rows.find(r => r.intent.batchIndex === batchIndex && r.intent.attempt === attempt);
      if (prior) {
        if (prior.receipt?.status !== 'recorded') fail('import_recovery_required');
        return output('import_already_recorded', prior.verified);
      }
      const previous = latest(rows).find(r => r.intent.batchIndex === batchIndex);
      if (attempt !== (previous?.intent.attempt ?? 0) + 1) fail('import_input');
      if (previous && previous.receipt?.status !== 'recorded' && await exists(join(previous.path, 'import/manifest.json')))
        fail('import_recovery_required');
      const intent = { batchIndex, attempt, createdAt: ctx.now(), evidenceSha256: hash(ctx.evidence),
        previousAttemptSha256: previous?.treeSha256 ?? null, operation: previous ? 'explicit_reimport' : 'first_import' };
      const intentRef = await save(join(path, 'attempts', key(batchIndex, attempt) + '.json'), intent);
      const directory = join(path, 'runs', key(batchIndex, attempt)); await mkdir(directory); await save(join(directory, 'intent.json'), intent);
      const row = { path: directory, intent, intentSha256: intentRef.sha256, receipt: null }, ref = ctx.evidence.batches[batchIndex];
      try {
        const result = await ctx.runChild('evaluation-details.mjs', ['import', ctx.configPath, ctx.evidence.unionPath, unionSha,
          ref.directory, ref.manifestSha256, join(directory, 'import')]);
        if (result.exitCode !== 0 || result.output.status !== 'detail_import_recorded' || !digest.test(result.output.artifactSha256 ?? ''))
          fail('import_child_failed');
        return await finish(ctx, row, false, result.output.artifactSha256);
      } catch {
        if (!await exists(join(directory, 'result.json'))) await save(join(directory, 'result.json'),
          { status: 'failed', intentSha256: intentRef.sha256, recordedAt: ctx.now(), importMayHaveCommitted: true });
        fail('import_recovery_required');
      }
    });
  }
  async function recover(root, collectionSha, unionSha, batchIndex, attempt) {
    return details.withDetails(root, collectionSha, unionSha, async ctx => {
      index(ctx, batchIndex, attempt);
      const rows = await inventory(ctx, await workspace(ctx, false));
      const row = latest(rows).find(r => r.intent.batchIndex === batchIndex && r.intent.attempt === attempt);
      if (!row) fail('import_input');
      if (row.receipt?.status === 'recorded') return output('import_already_recorded', row.verified);
      return finish(ctx, row, true);
    }, { allowStale: true });
  }
  async function reconcileAll(root, collectionSha, unionSha) {
    return details.withDetails(root, collectionSha, unionSha, async ctx => {
      const path = await workspace(ctx, true), rows = await inventory(ctx, path); complete(ctx, rows);
      const id = randomUUID(), directory = join(path, 'reviews', id); await mkdir(directory);
      const request = { attemptsSha256: stamp(rows), evidence: ctx.evidence, createdAt: ctx.now() };
      await save(join(directory, 'request.json'), request);
      const input = await save(join(directory, 'evidence.json'), ctx.evidence), report = join(directory, 'diagnostics.json');
      const result = await reconcile([join(directory, 'evidence.json'), input.sha256, report]);
      if (result.status !== 'import_reconciled' || !digest.test(result.artifactSha256 ?? '')) fail('import_reconciliation_failed');
      const verified = await verifyDiagnostics(report, result.artifactSha256, ctx.evidence);
      await save(join(directory, 'result.json'), { diagnosticsSha256: result.artifactSha256, requestSha256: await fileSha(join(directory, 'request.json')) });
      return output('imports_reconciled', { reviewId: id, coverage: verified.report.coverage, snapshotAt: verified.report.snapshotAt });
    });
  }
  async function exportConfig(root, collectionSha, unionSha, reviewId) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(reviewId ?? '')) fail('import_input');
    return details.withDetails(root, collectionSha, unionSha, async ctx => {
      const path = await workspace(ctx, false), rows = await inventory(ctx, path); complete(ctx, rows);
      if (!path) fail('import_incomplete');
      const review = await directory(join(path, 'reviews', reviewId)), receipt = await read(join(review, 'result.json'));
      const request = await read(join(review, 'request.json'), receipt.requestSha256);
      if (request.attemptsSha256 !== stamp(rows) || !same(request.evidence, ctx.evidence)) fail('import_stale_review');
      await verifyDiagnostics(join(review, 'diagnostics.json'), receipt.diagnosticsSha256, ctx.evidence);
      const base = V1ReleaseFilesSchema.parse(await read(join(ctx.session.bundle, 'frozen/config.json'), ctx.session.configSha256));
      const config = { ...base, evidence: ctx.evidence };
      for (const name of ['planPath', 'cataloguePath', 'developmentPath', 'candidatePath']) config[name] = resolve(ctx.session.bundle, base[name]);
      if (base.freeze) config.freeze = { ...base.freeze, path: resolve(ctx.session.bundle, base.freeze.path) };
      const exportDirectory = join(path, 'exports', randomUUID()); await mkdir(exportDirectory);
      const file = join(exportDirectory, 'execution.json'), saved = await save(file, V1ReleaseFilesSchema.parse(config));
      const checked = await ctx.runChild('release-execute.mjs', ['check', file, saved.sha256]);
      if (checked.exitCode !== 0 || checked.output.status !== 'release_capture_config_verified' || checked.output.executableFreezeComplete !== true)
        fail('import_execution_config');
      const result = output('import_execution_exported', { configPath: file, configSha256: saved.sha256, reviewId,
        attemptsSha256: stamp(rows), diagnosticsSha256: receipt.diagnosticsSha256, requiredBatches: ctx.selections.length });
      await save(join(exportDirectory, 'result.json'), result); return result;
    });
  }
  return { status, batch, recover, reconcile: reconcileAll, export: exportConfig };
}
