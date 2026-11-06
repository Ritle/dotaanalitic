import { mkdir, open, readFile, readdir, realpath, unlink, lstat } from 'node:fs/promises';
import { resolve, join, sep, dirname, basename } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readV1RegistryBundle } from './v1-registry-bundle.mjs';
import { bounded, sha, save } from './evaluation-discovery-files.mjs';

const runFile = promisify(execFile), digest = /^[a-f0-9]{64}$/;
const fail = code => { throw Error(code); };
const read = async (path, expected) => (await bounded(path, 33554432, expected)).data;
const fileSha = async path => sha(await readFile(path));
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const number = n => Number.isInteger(n) && n >= 1 && n <= 10;
const stamp = clock => { const at=clock(); if (new Date(at).toISOString() !== at) fail('collection_clock'); return at; };
const summary = (status, extra = {}) => ({ status, ...extra, metrics: null, teamAWinProbability: null, scoringPerformed: false });
async function execute(bundle, script, args) {
  try {
    const { stdout } = await runFile(process.execPath, [join(bundle, 'scripts', script), ...args],
      { cwd: bundle, windowsHide: true, timeout: 300000, maxBuffer: 1048576 });
    return { exitCode: 0, output: JSON.parse(stdout) };
  } catch (e) {
    // A partial source run is still evidence. Never expose raw stderr/environment.
    if (e.code === 3) { try { return { exitCode: 3, output: JSON.parse(e.stdout) }; } catch {} }
    fail('collection_child_failed');
  }
}

/** Operator orchestration only. The frozen collector remains the sole provider implementation. */
export function collectionManager({ verifyBundle = readV1RegistryBundle, run = execute,
  clock = () => new Date().toISOString() } = {}) {
  async function init(bundleInput, configSha256, freezeSha256, directory) {
    if (!digest.test(configSha256) || !digest.test(freezeSha256)) fail('collection_input');
    const bundle = await realpath(bundleInput), requested = resolve(directory);
    const root = join(await realpath(dirname(requested)), basename(requested));
    if (root === bundle || root.startsWith(bundle + sep)) fail('collection_inside_bundle');
    const artifact = await verifyBundle(bundle, configSha256, freezeSha256), plan = JSON.parse(artifact.planText);
    const source = await read(join(bundle, 'frozen/config.json'), configSha256);
    await mkdir(root); // Exclusive: never replace a prior session.
    const config = { kind: 'v1', planPath: resolve(bundle, source.planPath), planSha256: source.planSha256,
      evidenceAPath: resolve(bundle, source.cataloguePath), evidenceBPath: resolve(bundle, source.developmentPath),
      limits: { maxProPages: 2, maxLeagues: 10 } };
    const configRef = await save(join(root, 'discovery-config.json'), config);
    await mkdir(join(root, 'attempts')); await mkdir(join(root, 'runs')); await mkdir(join(root, 'unions'));
    const session = { schemaVersion: 1, format: 'v1-managed-discovery-v1', createdAt: stamp(clock), bundle,
      configSha256, freezeSha256, discoveryConfigSha256: configRef.sha256,
      planFingerprint: plan.fingerprint, testFromAt: plan.testFromAt, snapshotAt: plan.request.snapshotAt, maxRuns: 10 };
    const saved = await save(join(root, 'collection.json'), session);
    return summary('collection_initialized', { collectionSha256: saved.sha256, testFromAt: session.testFromAt, snapshotAt: session.snapshotAt });
  }
  async function context(directory, expected) {
    if (!digest.test(expected)) fail('collection_input');
    const root = await realpath(directory), session = await read(join(root, 'collection.json'), expected);
    if (session.format !== 'v1-managed-discovery-v1' || session.maxRuns !== 10 || !digest.test(session.discoveryConfigSha256)) fail('collection_session');
    const artifact = await verifyBundle(session.bundle, session.configSha256, session.freezeSha256);
    const plan = JSON.parse(artifact.planText);
    if (plan.fingerprint !== session.planFingerprint || plan.testFromAt !== session.testFromAt || plan.request.snapshotAt !== session.snapshotAt) fail('collection_plan_changed');
    const configPath = join(root, 'discovery-config.json');
    await read(configPath, session.discoveryConfigSha256);
    for (const dir of ['attempts', 'runs', 'unions']) if (await realpath(join(root, dir)) !== join(root, dir)) fail('collection_path');
    return { root, session, configPath };
  }
  async function withLock(ctx, task) {
    const path = join(ctx.root, 'lock.json'), token = randomUUID();
    let file;
    try { file = await open(path, 'wx'); } catch (e) { if (e.code === 'EEXIST') fail('collection_busy'); throw e; }
    try {
      await file.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname(), at: stamp(clock) })); await file.sync(); await file.close(); file = null;
      return await task();
    } finally {
      await file?.close();
      const held = await read(path); if (held.token === token) await unlink(path);
    }
  }
  async function inventory(ctx) {
    const names = (await readdir(join(ctx.root, 'runs'))).sort();
    const attempts = (await readdir(join(ctx.root,'attempts'))).sort();
    if (names.length > 10 || attempts.length !== names.length || names.some((name, i) =>
      name !== String(i + 1).padStart(2, '0') || attempts[i] !== name+'.json')) fail('collection_run_inventory');
    const rows = [];
    for (const name of names) {
      const directory = join(ctx.root, 'runs', name);
      if (await realpath(directory) !== directory) fail('collection_path');
      const intent = await read(join(directory, 'intent.json'));
      if (intent.run !== Number(name) || intent.discoveryConfigSha256 !== ctx.session.discoveryConfigSha256) fail('collection_run_binding');
      if (await fileSha(join(directory,'intent.json')) !== await fileSha(join(ctx.root,'attempts',name+'.json'))) fail('collection_run_binding');
      let receipt = await exists(join(directory, 'result.json')) ? await read(join(directory, 'result.json')) : null;
      if (receipt && (receipt.run !== intent.run || receipt.intentSha256 !== await fileSha(join(directory,'intent.json')) || !['captured','failed'].includes(receipt.status))) fail('collection_result_binding');
      const failedAttemptPreserved = receipt?.status === 'failed';
      if (await exists(join(directory,'recovery.json'))) {
        const recovered = await read(join(directory,'recovery.json'));
        if (!failedAttemptPreserved || recovered.failedResultSha256 !== await fileSha(join(directory,'result.json')) ||
          recovered.intentSha256 !== receipt.intentSha256 || recovered.run !== intent.run || recovered.status !== 'captured') fail('collection_result_binding');
        receipt = recovered;
      }
      if (receipt?.status === 'captured') {
        if (!digest.test(receipt.manifestSha256)) fail('collection_result_binding');
        await read(join(directory, 'capture', 'manifest.json'), receipt.manifestSha256);
      }
      rows.push({ run: Number(name), directory, intent, receipt, failedAttemptPreserved });
    }
    return rows;
  }
  async function verifyCapture(ctx, row, expected) {
    const capture = join(row.directory, 'capture');
    if (await realpath(capture) !== capture) fail('collection_path');
    const manifestSha256 = expected ?? await fileSha(join(capture, 'manifest.json'));
    const manifest = await read(join(capture, 'manifest.json'), manifestSha256);
    if (manifest.configSha256 !== ctx.session.discoveryConfigSha256 ||
      manifest.ledger?.scope?.planFingerprint !== ctx.session.planFingerprint) fail('collection_capture_binding');
    const checked = await run(ctx.session.bundle, 'collect-evaluation-discovery.mjs', ['verify', ctx.configPath, capture, manifestSha256]);
    if (checked.exitCode !== 0 || checked.output.status !== 'discovery_verified') fail('collection_verification_failed');
    return { manifestSha256, sourceStatus: checked.output.sourceStatus, summary: checked.output.summary };
  }
  async function finish(ctx, row, recovered) {
    const checked = await verifyCapture(ctx, row);
    const result = { run: row.run, status: 'captured', ...checked, recovered, recordedAt: stamp(clock),
      intentSha256: await fileSha(join(row.directory, 'intent.json')) };
    if (row.receipt?.status === 'failed') {
      result.failedResultSha256 = await fileSha(join(row.directory,'result.json'));
      await save(join(row.directory,'recovery.json'),result);
    } else await save(join(row.directory, 'result.json'), result);
    return result;
  }
  async function status(directory, expected) {
    const ctx = await context(directory, expected), rows = await inventory(ctx), now = stamp(clock);
    const phase = now < ctx.session.testFromAt ? 'not_started' : now >= ctx.session.snapshotAt ? 'source_deadline_passed' : 'collection_open';
    return summary(phase, { testFromAt: ctx.session.testFromAt, snapshotAt: ctx.session.snapshotAt,
      runs: rows.map(r => ({ run: r.run, status: r.receipt?.status ?? 'interrupted', failedAttemptPreserved:r.failedAttemptPreserved, sourceStatus: r.receipt?.sourceStatus ?? null,
        summary: r.receipt?.summary ?? null })), remainingRuns: 10 - rows.length,
      busy: await exists(join(ctx.root, 'lock.json')), collectionComplete: false, remoteCompleteness: 'unknown' });
  }
  async function collect(directory, expected, index) {
    if (!number(index)) fail('collection_input');
    const ctx = await context(directory, expected);
    return withLock(ctx, async () => {
      const rows = await inventory(ctx), prior = rows.find(r => r.run === index);
      if (prior) {
        if (prior.receipt?.status !== 'captured') fail('collection_recovery_required');
        const checked = await verifyCapture(ctx, prior, prior.receipt.manifestSha256);
        return summary('already_captured', { run: index, ...checked });
      }
      const at = stamp(clock);
      if (at < ctx.session.testFromAt) return summary('not_started', { testFromAt: ctx.session.testFromAt, providerRequests: 0 });
      if (at >= ctx.session.snapshotAt) fail('collection_source_deadline');
      if (index !== rows.length + 1 || rows.some(r => r.receipt?.status !== 'captured')) fail('collection_recovery_required');
      const directory = join(ctx.root, 'runs', String(index).padStart(2,'0'));
      const intent = { run: index, createdAt: at, discoveryConfigSha256: ctx.session.discoveryConfigSha256 };
      // Separate immutable intent catches a lost/deleted run folder, including the final run.
      await save(join(ctx.root,'attempts',String(index).padStart(2,'0')+'.json'),intent);
      await mkdir(directory);
      await save(join(directory, 'intent.json'), intent);
      const row = { run: index, directory, intent };
      try {
        const captured = await run(ctx.session.bundle, 'collect-evaluation-discovery.mjs', ['collect', ctx.configPath, join(directory, 'capture')]);
        if (![0,3].includes(captured.exitCode) || !digest.test(captured.output.manifestSha256 ?? '')) fail('collection_child_failed');
        if (await fileSha(join(directory,'capture','manifest.json')) !== captured.output.manifestSha256) fail('collection_capture_binding');
        return summary('captured', { ...(await finish(ctx, row, false)) });
      } catch {
        // Never discard a crash/failure, replace the capture, or start another network attempt implicitly.
        if (!await exists(join(directory,'result.json'))) await save(join(directory,'result.json'), {
          run: index, status: 'failed', recordedAt: stamp(clock), intentSha256: await fileSha(join(directory,'intent.json')) });
        fail('collection_recovery_required');
      }
    });
  }
  async function recover(directory, expected) {
    const ctx = await context(directory, expected);
    // A killed parent may leave its collector child alive. Never infer safe lock reclamation from PID liveness alone.
    return withLock(ctx, async () => {
      const rows = await inventory(ctx), pending = rows.filter(r => !r.receipt || r.receipt.status==='failed');
      for (const row of pending) await finish(ctx, row, true);
      return summary('recovered', { runs: pending.length, providerRequests: 0 });
    });
  }
  async function merge(directory, expected) {
    const ctx = await context(directory, expected);
    return withLock(ctx, async () => {
      const rows = await inventory(ctx);
      if (!rows.length || rows.some(r => r.receipt?.status !== 'captured')) fail('collection_incomplete');
      const refs = [];
      for (const row of rows) { await verifyCapture(ctx, row, row.receipt.manifestSha256);
        refs.push({ directory: join(row.directory,'capture'), manifestSha256: row.receipt.manifestSha256 }); }
      const version = join(ctx.root,'unions',randomUUID()); await mkdir(version);
      const refsPath = join(version,'runs.json'), output = join(version,'union.json'); await save(refsPath,refs);
      const merged = await run(ctx.session.bundle,'collect-evaluation-discovery.mjs',['merge',ctx.configPath,refsPath,output]);
      if (merged.exitCode !== 0 || merged.output.status !== 'discovery_merged' || await fileSha(output) !== merged.output.artifactSha256) fail('collection_merge_failed');
      const union = await read(output,merged.output.artifactSha256);
      const result = summary('merged', { unionPath: output, unionSha256: merged.output.artifactSha256,
        runs: rows.length, sourceStatus: union.ledger.status, discoveryConfigSha256: ctx.session.discoveryConfigSha256,
        summary: merged.output.summary, remoteCompleteness: 'unknown', readyForEvaluation: false });
      await save(join(version,'result.json'),result); return result;
    });
  }
  // Detail collection shares the same verified session and writer lock with discovery.
  async function withSession(directory, expected, operation) {
    const ctx = await context(directory, expected);
    return withLock(ctx, async () => operation({ ...ctx, rows: await inventory(ctx),
      runChild: (script, args) => run(ctx.session.bundle, script, args), now: () => stamp(clock) }));
  }
  return { init, status, collect, recover, merge, withSession };
}
