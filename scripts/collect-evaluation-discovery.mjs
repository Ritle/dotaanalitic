import { sha, bounded, save, scopeFor, verifyRun } from './lib/evaluation-discovery-files.mjs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { EvaluationDiscoveryCommandSchema } from '../packages/contracts/dist/index.js';
import { canonicalContextJson } from '../packages/db/dist/index.js';
import { createProviderRuntime, collectEvaluationDiscovery, buildEvaluationDiscoveryLedger } from '../packages/ingestion/dist/index.js';
async function codeManifest() {
  const paths = ['scripts/collect-evaluation-discovery.mjs', 'scripts/lib/evaluation-discovery-files.mjs', 'package.json', 'pnpm-lock.yaml'];
  for (const directory of ['packages/contracts/dist', 'packages/db/dist', 'packages/ingestion/dist']) {
    // Include nested provider modules, not only package index.js.
    for (const name of await readdir(new URL('../' + directory + '/', import.meta.url), { recursive: true }))
      if (name.endsWith('.js')) paths.push(directory + '/' + name.replaceAll('\\', '/'));
  }
  return Promise.all(paths.sort().map(async path => ({ path, sha256: sha(await readFile(new URL('../' + path, import.meta.url))) })));
}
const [mode, configPath, directory, fourth, ...extra] = process.argv.slice(2);
if (!['collect', 'verify', 'merge'].includes(mode) || !configPath || !directory || extra.length ||
  (mode === 'verify' ? !/^[a-f0-9]{64}$/.test(fourth ?? '') : mode === 'merge' ? !fourth : fourth !== undefined)) {
  console.error('Использование: collect config.json new-directory | verify config.json directory MANIFEST_SHA256 | merge config.json runs.json new-ledger.json'); process.exit(2);
}
let runtime;
try {
  const configInput = await bounded(configPath, 65536), config = EvaluationDiscoveryCommandSchema.parse(configInput.data);
  const scope = await scopeFor(config), root = resolve(directory);
  if (mode === 'collect') {
    // Exclusive directory creation prevents concurrent/repeated runs from replacing prior evidence.
    await mkdir(root);
    const requestRef = await save(join(root, 'request.json'), { config, configSha256: sha(configInput.bytes), scope, createdAt: new Date().toISOString() });
    const receipts = [];
    const persist = async entry => { const path = `receipt-${String(entry.sequence).padStart(3, '0')}.json`;
      receipts.push({ path, ...await save(join(root, path), entry) }); };
    // A future-window dry run needs no provider connection, token or quota transaction.
    let result;
    if (scope.windows.every(w => w.fromAt > new Date().toISOString())) {
      const time = new Date().toISOString();
      result = { ledger: buildEvaluationDiscoveryLedger(scope, [], time, time, config.limits, []) };
    } else {
      runtime = createProviderRuntime(process.env, 3 * (config.limits.maxProPages + config.limits.maxLeagues));
      result = await collectEvaluationDiscovery(scope, runtime.client, persist, config.limits);
    }
    const body = { schemaVersion: 1, format: 'evaluation-discovery-run-v1', configSha256: sha(configInput.bytes),
      ledger: result.ledger, request: requestRef, receipts, code: await codeManifest(), requestStats: runtime?.client.requestStats ?? { attempts: 0, httpStatuses: {}, transportErrors: {} } };
    const manifest = { ...body, fingerprint: sha(canonicalContextJson(body)) };
    const output = await save(join(root, 'manifest.json'), manifest);
    console.log(JSON.stringify({ status: result.ledger.status, manifestSha256: output.sha256, summary: result.ledger.summary,
      stoppingReasons: result.ledger.stoppingReasons, remoteCompleteness: 'unknown', metrics: null, deployable: false }));
    if (result.ledger.status === 'partial') process.exitCode = 3;
  } else if (mode === 'verify') {
    const { ledger: rebuilt } = await verifyRun(configInput, config, scope, root, fourth);
    console.log(JSON.stringify({ status: 'discovery_verified', fingerprint: rebuilt.fingerprint, summary: rebuilt.summary,
      sourceStatus: rebuilt.status, remoteCompleteness: 'unknown', metrics: null, deployable: false }));
  } else {
    const { data: refs } = await bounded(directory, 65536);
    if (!Array.isArray(refs) || !refs.length || refs.length > 10 || refs.some(r => typeof r.directory !== 'string' ||
      !/^[a-f0-9]{64}$/.test(r.manifestSha256 ?? '')) || new Set(refs.map(r => r.manifestSha256)).size !== refs.length) throw Error('discovery_merge_refs');
    refs.sort((a, b) => a.manifestSha256.localeCompare(b.manifestSha256));
    const runs = [];
    for (const ref of refs) runs.push(await verifyRun(configInput, config, scope, resolve(ref.directory), ref.manifestSha256));
    const entries = runs.flatMap(r => r.entries).map((entry, i) => ({ ...entry, sequence: i }));
    const starts = runs.map(r => r.ledger.startedAt).sort(), ends = runs.map(r => r.ledger.completedAt).sort();
    const merged = buildEvaluationDiscoveryLedger(scope, entries, starts[0], ends.at(-1), config.limits,
      [...new Set(runs.flatMap(r => r.ledger.stoppingReasons))].filter(r => !['INVENTORY_LIMIT', 'AFTER_EVALUATION_SNAPSHOT'].includes(r)));
    const body = { schemaVersion: 1, format: 'evaluation-discovery-union-v1', configSha256: sha(configInput.bytes),
      runs: refs, ledger: merged, aggregation: 'all_supplied_runs_union_no_removal_or_conflict_overwrite',
      sourceHistoryCompleteness: 'only_explicitly_supplied_runs', metrics: null, deployable: false };
    const out = await save(fourth, { ...body, fingerprint: sha(canonicalContextJson(body)) });
    console.log(JSON.stringify({ status: 'discovery_merged', artifactSha256: out.sha256, runs: refs.length, summary: merged.summary, metrics: null, deployable: false }));
  }
} catch (error) {
  const allowed = ['discovery_file_sha_mismatch', 'discovery_manifest_binding', 'discovery_ledger_replay_mismatch',
    'discovery_unmanifested_receipt', 'discovery_payload_sha_mismatch'];
  console.error(JSON.stringify({ status: 'unavailable', code: error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' :
    allowed.includes(error?.message) ? error.message.toUpperCase() : 'DISCOVERY_REJECTED',
    message: error?.code === 'EEXIST' ? 'Каталог уже существует. Предыдущие записи сохранены.' :
      'Сбор не завершён. Проверьте план, SHA, настройки источника и файлы журнала. Уже сохранённые ответы остаются в каталоге.' }));
  process.exitCode = 1;
} finally { await runtime?.close(); }
