import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { collectionManager } from '../../scripts/lib/v1-collection.mjs';
import { detailCollectionManager } from '../../scripts/lib/v1-detail-collection.mjs';
import { selectEvaluationDetailBatch } from '../../packages/ingestion/dist/index.js';
import { sha } from '../../scripts/lib/evaluation-discovery-files.mjs';

// Synthetic operator fixtures; frozen source replay is also exercised in its existing integration suites.
async function fixture(t, count = 51) {
  const root = await mkdtemp(join(tmpdir(), 'dota-detail-'));
  t.after(() => { assert(root.startsWith(resolve(tmpdir()) + sep + 'dota-detail-')); return rm(root, { recursive: true, force: true }); });
  const bundle = join(root, 'bundle'), directory = join(root, 'session'); await mkdir(join(bundle, 'frozen'), { recursive: true });
  const plan = { fingerprint: 'a'.repeat(64), testFromAt: '2099-11-20T00:00:00.000Z', request: { snapshotAt: '2099-12-02T00:00:00.000Z' } };
  const config = JSON.stringify({ planPath: 'frozen/plan.json', planSha256: 'b'.repeat(64), cataloguePath: 'frozen/catalogue.json', developmentPath: 'frozen/development.json' });
  await writeFile(join(bundle, 'frozen/config.json'), config);
  let at = '2099-11-21T00:00:00.000Z', interrupted = false, failFetch = false, blocked = null, corrupt = false;
  const calls = [];
  const ledger = { fingerprint: 'f'.repeat(64), scope: { planFingerprint: plan.fingerprint, maxMaps: 5000 }, status: 'discovered',
    candidates: Array.from({ length: count }, (_, i) => ({ matchId: String(BigInt('9007199254741000') + BigInt(i)),
      possibleTarget: i !== count - 1, disposition: i === count - 1 ? 'related_series_member' : 'pending_detail_verification' })).reverse() };
  const run = async (_, script, args) => {
    calls.push({ script, mode: args[0], args });
    if (script === 'collect-evaluation-discovery.mjs') {
      if (args[0] === 'collect') {
        await mkdir(args[2]); const bytes = JSON.stringify({ configSha256: sha(await readFile(args[1])), ledger });
        await writeFile(join(args[2], 'manifest.json'), bytes); return { exitCode: 0, output: { manifestSha256: sha(bytes) } };
      }
      if (args[0] === 'verify') return { exitCode: 0, output: { status: 'discovery_verified', sourceStatus: 'discovered', summary: {} } };
      if (args[0] === 'merge') {
        const union = { configSha256: sha(await readFile(args[1])), ledger, runs: JSON.parse(await readFile(args[2], 'utf8')) };
        const bytes = JSON.stringify(union); await writeFile(args[3], bytes);
        return { exitCode: 0, output: { status: 'discovery_merged', artifactSha256: sha(bytes), summary: {} } };
      }
    }
    if (script === 'evaluation-details.mjs' && args[0] === 'capture') {
      if (blocked) await blocked;
      const selection = selectEvaluationDetailBatch(ledger, Number(args[4]));
      const assessment = { fingerprint: sha('synthetic-' + args[4]), selection,
        assessments: selection.selectedIds.map((matchId, i) => ({ matchId, sourceEligible: !(failFetch && i === 0), reasons: failFetch && i === 0 ? ['DETAIL_FETCH_FAILED'] : [] })) };
      const bytes = JSON.stringify({ unionSha256: args[3], discoveryFingerprint: ledger.fingerprint, assessment });
      await mkdir(args[5]); await writeFile(join(args[5], 'manifest.json'), bytes);
      if (interrupted) throw Error('synthetic_interruption');
      return { exitCode: 0, output: { status: 'details_captured', manifestSha256: sha(bytes) } };
    }
    if (script === 'evaluation-details.mjs' && args[0] === 'verify') {
      if (corrupt) throw Error('synthetic_replay_failure');
      const bytes = await readFile(join(args[4], 'manifest.json')); assert.equal(sha(bytes), args[5]);
      return { exitCode: 0, output: { status: 'details_verified', fingerprint: JSON.parse(bytes).assessment.fingerprint } };
    }
    assert.fail('Unexpected frozen command');
  };
  const manager = collectionManager({ verifyBundle: async () => ({ planText: JSON.stringify(plan) }), run, clock: () => at });
  const init = await manager.init(bundle, sha(config), 'c'.repeat(64), directory), parentArgs = [directory, init.collectionSha256];
  await manager.collect(...parentArgs, 1); const merged = await manager.merge(...parentArgs);
  const details = detailCollectionManager({ manager, verifyUnion: async (_, path, digest) => {
    const bytes = await readFile(path); assert.equal(sha(bytes), digest); return JSON.parse(bytes);
  } });
  const args = [...parentArgs, merged.unionSha256];
  const prepared = await details.init(...parentArgs, merged.unionPath, merged.unionSha256);
  return { manager, details, parentArgs, args, prepared, merged, directory, ledger, calls,
    path: join(directory, 'details', merged.unionSha256), setAt: v => at = v, setInterrupted: v => interrupted = v,
    setFailFetch: v => failFetch = v, setBlocked: v => blocked = v, setCorrupt: v => corrupt = v,
    captures: () => calls.filter(c => c.script === 'evaluation-details.mjs' && c.mode === 'capture') };
}

test('51 maps including the outside-window series sibling produce two fixed bigint-safe batches', async t => {
  const f = await fixture(t); assert.equal(f.prepared.requiredBatches, 2);
  await f.details.capture(...f.args, 0); await f.details.capture(...f.args, 1);
  const status = await f.details.status(...f.args); assert.deepEqual(status.missing, []);
  assert.deepEqual(status.batches.map(b => b.selected), [50, 1]); assert.equal(status.readyForEvaluation, false);
  const plan = JSON.parse(await readFile(join(f.path, 'plan.json'), 'utf8'));
  assert.equal(plan.layout.requiredIds[0], '9007199254741000');
  assert.equal(plan.layout.batches[1].selectedIds[0], '9007199254741050');
  const exported = await f.details.export(...f.args); const evidence = JSON.parse(await readFile(exported.evidencePath, 'utf8'));
  assert.equal(evidence.batches.length, 2); assert.equal(evidence.unionSha256, f.merged.unionSha256);
});
test('zero targets require zero batches, never a fake empty batch or a claim of model readiness', async t => {
  const f = await fixture(t, 0); assert.equal(f.prepared.requiredBatches, 0);
  await assert.rejects(f.details.capture(...f.args, 0), /batch_range/);
  const exported = await f.details.export(...f.args); assert.equal(exported.requiredBatches, 0);
  assert.equal(exported.readyForEvaluation, false); assert.equal(f.captures().length, 0);
});
test('pre-window and exact deadline guards do not consume a batch or issue HTTP', async t => {
  const f = await fixture(t); f.setAt('2099-11-19T23:59:59.999Z');
  assert.equal((await f.details.capture(...f.args, 0)).status, 'not_started');
  f.setAt('2099-12-02T00:00:00.000Z'); await assert.rejects(f.details.capture(...f.args, 0), /source_deadline/);
  assert.equal(f.captures().length, 0); assert.deepEqual(await readdir(join(f.path, 'attempts')), []);
});
test('exact retry after the deadline verifies the existing bytes without another source request', async t => {
  const f = await fixture(t); await f.details.capture(...f.args, 0); f.setAt('2099-12-03T00:00:00.000Z');
  assert.equal((await f.details.capture(...f.args, 0)).status, 'detail_already_captured'); assert.equal(f.captures().length, 1);
});
test('missing batch prevents export; failed source rows remain inside a complete batch list', async t => {
  const f = await fixture(t); f.setFailFetch(true); await f.details.capture(...f.args, 1);
  assert.deepEqual((await f.details.status(...f.args)).missing, [0]);
  await assert.rejects(f.details.export(...f.args), /incomplete/); await f.details.capture(...f.args, 0);
  const exported = await f.details.export(...f.args); assert.equal(exported.sourceIneligible, 2); assert.equal(exported.requiredBatches, 2);
  assert.equal(exported.readyForEvaluation, false);
});
test('interruption with a full capture is recovered without HTTP and keeps the original failed result', async t => {
  const f = await fixture(t); f.setInterrupted(true); await assert.rejects(f.details.capture(...f.args, 0), /recovery_required/);
  const file = join(f.path, 'batches/00/result.json'), before = await readFile(file);
  await assert.rejects(f.details.capture(...f.args, 1), /recovery_required/);
  f.setAt('2099-12-03T00:00:00.000Z'); assert.equal((await f.details.recover(...f.args)).batches, 1);
  assert.deepEqual(await readFile(file), before); assert.equal((await f.details.status(...f.args)).batches[0].failedAttemptPreserved, true);
  assert.equal(f.captures().length, 1);
});
test('a lost completed batch or changed manifest cannot disappear from the denominator', async t => {
  const f = await fixture(t); await f.details.capture(...f.args, 1);
  await writeFile(join(f.path, 'batches/01/capture/manifest.json'), '{}'); await assert.rejects(f.details.export(...f.args));
  await assert.rejects(f.details.status(...f.args), /sha_mismatch/);
  await assert.rejects(f.details.capture(...f.args, 0), /sha_mismatch/); assert.equal(f.captures().length, 1);
  const path = join(f.path, 'batches/01'); assert(path.startsWith(f.path + sep)); await rm(path, { recursive: true });
  await assert.rejects(f.details.capture(...f.args, 1), /inventory/); assert.equal(f.captures().length, 1);
});
test('incomplete crash recovery does not fetch again or permit the next batch', async t => {
  const f = await fixture(t); f.setInterrupted(true); await assert.rejects(f.details.capture(...f.args, 0));
  await unlink(join(f.path, 'batches/00/capture/manifest.json')); await assert.rejects(f.details.recover(...f.args));
  await assert.rejects(f.details.capture(...f.args, 1), /recovery_required/); assert.equal(f.captures().length, 1);
});
test('discovery and all detail operations share a single writer lock', async t => {
  const f = await fixture(t); let release; f.setBlocked(new Promise(r => release = r));
  const running = f.details.capture(...f.args, 0); while (!f.captures().length) await new Promise(r => setTimeout(r, 5));
  await assert.rejects(f.manager.collect(...f.parentArgs, 2), /collection_busy/);
  await assert.rejects(f.details.capture(...f.args, 0), /collection_busy/);
  await assert.rejects(f.details.recover(...f.args), /collection_busy/); release(); await running;
});
test('new discovery invalidates old union for new HTTP/export, but old captures remain verifiable', async t => {
  const f = await fixture(t); await f.details.capture(...f.args, 0); await f.manager.collect(...f.parentArgs, 2);
  assert.equal((await f.details.status(...f.args)).currentDiscovery, false);
  await assert.rejects(f.details.capture(...f.args, 1), /stale_union/); await assert.rejects(f.details.export(...f.args), /stale_union/);
  assert.equal((await f.details.capture(...f.args, 0)).status, 'detail_already_captured'); assert.equal(f.captures().length, 1);
});
test('foreign or altered union, changed plan and replay failure cannot become an export', async t => {
  const f = await fixture(t); await assert.rejects(f.details.init(...f.parentArgs, f.merged.unionPath, 'e'.repeat(64)), /union_binding/);
  await f.details.capture(...f.args, 0); await f.details.capture(...f.args, 1); f.setCorrupt(true);
  await assert.rejects(f.details.export(...f.args), /synthetic_replay_failure/);
  await writeFile(join(f.path, 'plan.json'), '{}'); await assert.rejects(f.details.status(...f.args), /sha_mismatch/);
});
test('duplicate preparation is idempotent and indices beyond the required plan are rejected', async t => {
  const f = await fixture(t, 50); const bytes = await readFile(join(f.path, 'plan.json'));
  assert.equal((await f.details.init(...f.parentArgs, f.merged.unionPath, f.merged.unionSha256)).status, 'details_already_prepared');
  assert.deepEqual(await readFile(join(f.path, 'plan.json')), bytes);
  for (const n of [-1, 1, 100, 0.5]) await assert.rejects(f.details.capture(...f.args, n));
  assert.equal(f.captures().length, 0);
});
test('stale complete sources remain available for import audit/recovery but cannot authorize new writes', async t => {
  const f = await fixture(t, 1); await f.details.capture(...f.args, 0); await f.manager.collect(...f.parentArgs, 2);
  await assert.rejects(f.details.withDetails(...f.args, async () => true), /stale_union/);
  const snapshot = await f.details.withDetails(...f.args, async ctx => ({ current: ctx.currentDiscovery, batches: ctx.evidence.batches.length }), { allowStale: true });
  assert.deepEqual(snapshot, { current: false, batches: 1 }); assert.equal(f.captures().length, 1);
});
