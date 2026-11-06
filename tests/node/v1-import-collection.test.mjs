import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { importCollectionManager } from '../../scripts/lib/v1-import-collection.mjs';
import { sha, save } from '../../scripts/lib/evaluation-discovery-files.mjs';
import { canonicalContextJson } from '../../packages/db/dist/index.js';
const hash = v => sha(canonicalContextJson(v));
async function fixture(t, count = 2, excluded = false) {
  const root = await mkdtemp(join(tmpdir(), 'dota-import-'));
  t.after(() => { assert(root.startsWith(resolve(tmpdir()) + sep + 'dota-import-')); return rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'frozen')); await mkdir(join(root, 'detail'));
  const selections = Array.from({ length: count }, (_, i) => ({ batchIndex: i, batchSize: 50, allRequiredIds: [], selectedIds: [String(9000000000000000n + BigInt(i))], deferredIds: [] }));
  const refs = [];
  for (const s of selections) {
    const directory = join(root, 'capture-' + s.batchIndex); await mkdir(directory);
    const manifest = await save(join(directory, 'manifest.json'), { assessment: { assessments: s.selectedIds.map(matchId => ({
      matchId, sourceEligible: !excluded, reasons: excluded ? ['DETAIL_FETCH_FAILED'] : [] })) } });
    refs.push({ directory, manifestSha256: manifest.sha256 });
  }
  const evidence = { configPath: join(root, 'config.json'), configSha256: 'a'.repeat(64), unionPath: join(root, 'union.json'), unionSha256: 'b'.repeat(64), batches: refs };
  const config = { planPath: 'frozen/plan.json', planSha256: 'a'.repeat(64), cataloguePath: 'frozen/catalogue.json', developmentPath: 'frozen/development.json',
    candidatePath: 'frozen/candidate.json', candidateSha256: 'c'.repeat(64), freeze: { path: 'frozen/freeze.json', sha256: 'd'.repeat(64) }, evidence };
  const base = await save(join(root, 'frozen/config.json'), config);
  const calls = []; let mode = 'ok', locked = false, hold = null;
  const ctx = { root, detailRoot: join(root, 'detail'), configPath: evidence.configPath, selections, evidence,
    session: { bundle: root, configSha256: base.sha256 }, now: () => '2099-11-21T00:00:00.000Z',
    runChild: async (script, args) => {
      calls.push(args[0]); if (hold) await hold;
      if (script === 'release-execute.mjs') return { exitCode: 0, output: { status: 'release_capture_config_verified', executableFreezeComplete: true } };
      assert.equal(args[0], 'import');
      const i = refs.findIndex(r => r.directory === args[4]), path = args[6]; await mkdir(path);
      await save(join(path, 'request.json'), { unionSha256: evidence.unionSha256, captureSha256: refs[i].manifestSha256, selection: selections[i] });
      const result = excluded ? { matchId: selections[i].selectedIds[0], status: 'not_importable', reasons: ['DETAIL_FETCH_FAILED'] } :
        { matchId: selections[i].selectedIds[0], receiptId: '1', status: mode === 'map_failure' ? 'import_failed' : 'accepted', duplicate: false, dataRevision: '1' };
      if (mode === 'map_failure') { delete result.receiptId; delete result.duplicate; delete result.dataRevision; result.reasons = ['CANONICAL_IMPORT_FAILED']; }
      await save(join(path, 'result-' + result.matchId + '.json'), result);
      if (mode === 'partial_crash') throw Error('synthetic_crash');
      const body = { schemaVersion: 1, format: 'evaluation-detail-import-v1', unionSha256: evidence.unionSha256,
        captureSha256: refs[i].manifestSha256, completedAt: ctx.now(), results: [result], code: [{ path: 'synthetic', sha256: 'f'.repeat(64) }],
        providerRequests: 0, modelWrites: 0, metrics: null, deployable: false };
      const saved = await save(join(path, 'manifest.json'), { ...body, fingerprint: hash(body) });
      if (mode === 'full_crash') throw Error('synthetic_crash');
      return { exitCode: 0, output: { status: 'detail_import_recorded', artifactSha256: saved.sha256 } };
    } };
  const details = { withDetails: async (_root, _sha, _union, task) => {
    if (locked) throw Error('collection_busy'); locked = true; try { return await task(ctx); } finally { locked = false; }
  } };
  const manager = importCollectionManager({ details, reconcile: async args => {
    const saved = await save(args[2], { evidence, report: { coverage: { observedTargetMaps: count, dataReadyMaps: 0, mapCoverage: count ? 0 : null }, snapshotAt: ctx.now() } });
    return { status: 'import_reconciled', artifactSha256: saved.sha256 };
  }, verifyDiagnostics: async (path, digest, expected) => {
    const bytes = await readFile(path); assert.equal(sha(bytes), digest); const report = JSON.parse(bytes); assert.deepEqual(report.evidence, expected); return report;
  } });
  return { root, ctx, manager, args: [root, 'synthetic', evidence.unionSha256], calls, setMode: v => mode = v, setHold: v => hold = v,
    run: (batch, attempt) => join(ctx.detailRoot, 'imports/runs', String(batch).padStart(2, '0') + '-' + String(attempt).padStart(2, '0')) };
}
test('same import attempt replays its journal; complete source export keeps frozen config references', async t => {
  const f = await fixture(t);
  await f.manager.batch(...f.args, 0, 1); await f.manager.batch(...f.args, 1, 1);
  assert.equal((await f.manager.batch(...f.args, 0, 1)).status, 'import_already_recorded'); assert.equal(f.calls.length, 2);
  const review = await f.manager.reconcile(...f.args), exported = await f.manager.export(...f.args, review.reviewId);
  const config = JSON.parse(await readFile(exported.configPath, 'utf8'));
  assert.equal(config.evidence.batches.length, 2); assert.equal(config.planSha256, 'a'.repeat(64));
  assert.equal(config.freeze.sha256, 'd'.repeat(64)); assert.equal(config.freeze.path, join(f.root, 'frozen/freeze.json'));
  assert.equal(exported.readyForEvaluation, false);
});
test('complete interrupted manifest recovers without another DB import and preserves original failure', async t => {
  const f = await fixture(t, 1); f.setMode('full_crash'); await assert.rejects(f.manager.batch(...f.args, 0, 1), /recovery_required/);
  const path = join(f.run(0, 1), 'result.json'), old = await readFile(path);
  await assert.rejects(f.manager.batch(...f.args, 0, 2), /recovery_required/);
  assert.equal((await f.manager.recover(...f.args, 0, 1)).status, 'import_recorded');
  assert.deepEqual(await readFile(path), old); assert.equal(f.calls.length, 1);
  assert.equal((await f.manager.status(...f.args)).attempts[0].failurePreserved, true);
});
test('partial crash allows only an explicit next attempt and hash-links every prior file', async t => {
  const f = await fixture(t, 1); f.setMode('partial_crash'); await assert.rejects(f.manager.batch(...f.args, 0, 1));
  await assert.rejects(f.manager.batch(...f.args, 0, 1), /recovery_required/);
  await assert.rejects(f.manager.recover(...f.args, 0, 1)); f.setMode('ok');
  await f.manager.batch(...f.args, 0, 2); assert.equal(f.calls.length, 2);
  const status = await f.manager.status(...f.args); assert.deepEqual(status.attempts.map(a => a.status), ['failed', 'recorded']);
  await assert.rejects(f.manager.recover(...f.args, 0, 1), /input/);
  await writeFile(join(f.run(0, 1), 'import/result-9000000000000000.json'), '{}');
  await assert.rejects(f.manager.status(...f.args), /inventory/);
});
test('a missing batch prevents reconciliation and no skipped attempt number is accepted', async t => {
  const f = await fixture(t); await f.manager.batch(...f.args, 0, 1);
  assert.deepEqual((await f.manager.status(...f.args)).missing, [1]);
  await assert.rejects(f.manager.reconcile(...f.args), /incomplete/);
  await assert.rejects(f.manager.batch(...f.args, 1, 2), /input/); assert.equal(f.calls.length, 1);
});
test('source-ineligible rows and per-map DB failures stay in counts and never imply model readiness', async t => {
  for (const excluded of [true, false]) {
    const f = await fixture(t, 1, excluded); if (!excluded) f.setMode('map_failure');
    const imported = await f.manager.batch(...f.args, 0, 1);
    assert.equal(imported.counts[excluded ? 'not_importable' : 'import_failed'], 1);
    const review = await f.manager.reconcile(...f.args); assert.equal(review.readyForEvaluation, false);
    assert.equal(review.coverage.dataReadyMaps, 0);
  }
});
test('changed map results and lost last attempt are rejected before another DB write', async t => {
  const f = await fixture(t, 1); await f.manager.batch(...f.args, 0, 1);
  await writeFile(join(f.run(0, 1), 'import/result-9000000000000000.json'), '{}');
  await assert.rejects(f.manager.batch(...f.args, 0, 2), /artifact_binding/);
  const path = f.run(0, 1); assert(path.startsWith(f.root + sep)); await rm(path, { recursive: true });
  await assert.rejects(f.manager.status(...f.args), /inventory/); assert.equal(f.calls.length, 1);
});
test('a new import invalidates the previous review, while previous exports remain intact', async t => {
  const f = await fixture(t, 1); await f.manager.batch(...f.args, 0, 1);
  const review = await f.manager.reconcile(...f.args), exported = await f.manager.export(...f.args, review.reviewId);
  const bytes = await readFile(exported.configPath); await f.manager.batch(...f.args, 0, 2);
  await assert.rejects(f.manager.export(...f.args, review.reviewId), /stale_review/);
  assert.deepEqual(await readFile(exported.configPath), bytes);
});
test('imports, recovery and reconciliation use the shared detail writer lock', async t => {
  const f = await fixture(t, 1); let release; f.setHold(new Promise(r => release = r));
  const running = f.manager.batch(...f.args, 0, 1); while (!f.calls.length) await new Promise(r => setTimeout(r, 5));
  await assert.rejects(f.manager.reconcile(...f.args), /collection_busy/); await assert.rejects(f.manager.recover(...f.args, 0, 1), /collection_busy/);
  release(); await running;
});
test('zero target batches produce nullable coverage without an invented import', async t => {
  const f = await fixture(t, 0); assert.deepEqual((await f.manager.status(...f.args)).missing, []);
  await assert.rejects(f.manager.batch(...f.args, 0, 1), /input/);
  const review = await f.manager.reconcile(...f.args); assert.equal(review.coverage.mapCoverage, null);
  assert.equal((await f.manager.export(...f.args, review.reviewId)).readyForEvaluation, false); assert.deepEqual(f.calls, ['check']);
});
test('extra unmanifested file or a modified manifest blocks replay and review', async t => {
  const f = await fixture(t, 1); await f.manager.batch(...f.args, 0, 1);
  await writeFile(join(f.run(0, 1), 'import/extra.json'), '{}'); await assert.rejects(f.manager.status(...f.args), /artifact_binding/);
  await writeFile(join(f.run(0, 1), 'import/manifest.json'), '{}'); await assert.rejects(f.manager.reconcile(...f.args), /sha_mismatch/);
  assert.equal(f.calls.length, 1);
});
