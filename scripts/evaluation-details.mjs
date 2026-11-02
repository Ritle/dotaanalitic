import { loadCapture } from './lib/evaluation-detail-files.mjs';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { sha, bounded, save, loadDiscoveryContext, verifyDiscoveryUnion } from './lib/evaluation-discovery-files.mjs';
import { createDatabase, canonicalContextJson, V1DataRepository } from '../packages/db/dist/index.js';
import { createProviderRuntime, captureEvaluationDetails, validateEvaluationDetails, selectEvaluationDetailBatch,
  reconcileEvaluationCandidates, IngestionService } from '../packages/ingestion/dist/index.js';

async function codeManifest() {
  const paths = ['scripts/evaluation-details.mjs', 'scripts/lib/evaluation-discovery-files.mjs', 'scripts/lib/evaluation-detail-files.mjs', 'package.json', 'pnpm-lock.yaml'];
  for (const directory of ['packages/contracts/dist', 'packages/db/dist', 'packages/ingestion/dist', 'packages/db/migrations'])
    for (const name of await readdir(new URL('../' + directory + '/', import.meta.url), { recursive: true }))
      if (name.endsWith('.js') || name.endsWith('.sql')) paths.push(directory + '/' + name.replaceAll('\\', '/'));
  return Promise.all(paths.sort().map(async path => ({ path, sha256: sha(await readFile(new URL('../' + path, import.meta.url))) })));
}

const [mode, configPath, unionPath, unionSha, fifth, sixth, seventh, ...extra] = process.argv.slice(2);
if (!['capture', 'verify', 'import', 'reconcile', 'verify-reconciliation'].includes(mode) || !configPath || !unionPath || !/^[a-f0-9]{64}$/.test(unionSha ?? '') ||
  !fifth || !sixth || extra.length || (mode === 'capture' ? seventh !== undefined || !/^\d{1,2}$/.test(fifth) :
    !/^[a-f0-9]{64}$/.test(sixth) || (mode === 'verify' ? seventh !== undefined : !seventh))) {
  console.error('Использование: capture config.json union.json SHA256 batchIndex new-directory | verify config.json union.json SHA256 capture-dir CAPTURE_SHA | import config.json union.json SHA256 capture-dir CAPTURE_SHA new-directory | reconcile config.json union.json SHA256 capture-dir CAPTURE_SHA new-report.json | verify-reconciliation config.json union.json SHA256 report.json REPORT_SHA capture-dir');
  process.exit(2);
}
let runtime, db, importCommitted = false;
try {
  const context = await loadDiscoveryContext(configPath), union = await verifyDiscoveryUnion(context, unionPath, unionSha), ledger = union.ledger;
  if (mode === 'capture') {
    const root = resolve(sixth), selection = selectEvaluationDetailBatch(ledger, Number(fifth));
    await mkdir(root);
    const request = await save(join(root, 'request.json'), { unionSha256: unionSha, discoveryFingerprint: ledger.fingerprint, selection, createdAt: new Date().toISOString() });
    const receipts = [];
    const persist = async entry => { const path = `receipt-${String(receipts.length).padStart(3, '0')}.json`; receipts.push({ path, ...await save(join(root, path), entry) }); };
    let result;
    if (selection.selectedIds.length) {
      runtime = createProviderRuntime(process.env, (selection.selectedIds.length + 2) * 3);
      result = await captureEvaluationDetails(ledger, Number(fifth), runtime.client, persist);
    } else {
      const now = new Date().toISOString();
      result = validateEvaluationDetails(ledger, [], Number(fifth), now, now);
    }
    const body = { schemaVersion: 1, format: 'evaluation-details-capture-v1', unionSha256: unionSha,
      discoveryFingerprint: ledger.fingerprint, request, receipts, assessment: result.report, code: await codeManifest(),
      requestStats: runtime?.client.requestStats ?? { attempts: 0, httpStatuses: {}, transportErrors: {} } };
    const output = await save(join(root, 'manifest.json'), { ...body, fingerprint: sha(canonicalContextJson(body)) });
    console.log(JSON.stringify({ status: 'details_captured', manifestSha256: output.sha256, selected: selection.selectedIds.length,
      deferred: selection.deferredIds.length, sourceEligible: result.report.assessments.filter(a => a.sourceEligible).length,
      failed: receipts.length ? result.report.assessments.filter(a => a.reasons.includes('DETAIL_FETCH_FAILED')).length : 0,
      metrics: null, deployable: false }));
  } else if (mode === 'verify-reconciliation') {
    const { data: saved } = await bounded(fifth, 33554432, sixth), { fingerprint, ...body } = saved;
    if (saved.format !== 'evaluation-reconciliation-envelope-v1' || sha(canonicalContextJson(body)) !== fingerprint || saved.unionSha256 !== unionSha) throw Error('detail_reconciliation_binding_invalid');
    const capture = await loadCapture(ledger, unionSha, seventh, saved.captureSha256);
    const report = reconcileEvaluationCandidates(ledger, saved.dataset, capture.report);
    if (canonicalContextJson(report) !== canonicalContextJson(saved.report)) throw Error('detail_reconciliation_replay_mismatch');
    console.log(JSON.stringify({ status: 'reconciliation_verified', coverage: report.coverage, metrics: null, deployable: false }));
  } else {
    const capture = await loadCapture(ledger, unionSha, fifth, sixth);
    if (mode === 'verify') {
      console.log(JSON.stringify({ status: 'details_verified', fingerprint: capture.report.fingerprint,
        selected: capture.report.selection.selectedIds.length, sourceEligible: capture.report.assessments.filter(a => a.sourceEligible).length, metrics: null, deployable: false }));
    } else if (mode === 'import') {
      const root = resolve(seventh); await mkdir(root);
      await save(join(root, 'request.json'), { unionSha256: unionSha, captureSha256: sixth, selection: capture.report.selection });
      if (!process.env.DATABASE_URL) throw Error('detail_database_required');
      db = createDatabase(process.env.DATABASE_URL);
      const importer = new IngestionService(db, capture.provider), results = [];
      for (const row of capture.report.assessments) {
        let result;
        if (!row.sourceEligible) result = { matchId: row.matchId, status: 'not_importable', reasons: row.reasons };
        else {
          try { importCommitted = true; result = await importer.ingest(row.matchId); }
          catch { result = { matchId: row.matchId, status: 'import_failed', reasons: ['CANONICAL_IMPORT_FAILED'] }; }
        }
        // Persist each result immediately; a later failure must not conceal already committed imports.
        await save(join(root, `result-${row.matchId}.json`), result); results.push(result);
      }
      const body = { schemaVersion: 1, format: 'evaluation-detail-import-v1', unionSha256: unionSha, captureSha256: sixth,
        completedAt: new Date().toISOString(), results, code: await codeManifest(), providerRequests: 0,
        modelWrites: 0, metrics: null, deployable: false };
      const output = await save(join(root, 'manifest.json'), { ...body, fingerprint: sha(canonicalContextJson(body)) });
      console.log(JSON.stringify({ status: 'detail_import_recorded', artifactSha256: output.sha256, results, providerRequests: 0, metrics: null, deployable: false }));
    } else {
      // Reserve destination before DB work, so a repeated command cannot overwrite a frozen report.
      const destination = await open(seventh, 'wx');
      try {
        if (!process.env.DATABASE_URL) throw Error('detail_database_required');
        db = createDatabase(process.env.DATABASE_URL);
        const snapshotAt = new Date().toISOString(), fromAt = context.warmupFromAt;
        const dataset = await new V1DataRepository(db).export({ schemaVersion: 1, profile: 'pre-match-player-elo-data-v1', purpose: 'development_only',
          fromAt, toAt: snapshotAt, snapshotAt, maxMaps: 5000 }, await codeManifest());
        const report = reconcileEvaluationCandidates(ledger, dataset, capture.report);
        const body = { schemaVersion: 1, format: 'evaluation-reconciliation-envelope-v1', unionSha256: unionSha, captureSha256: sixth,
          dataset, report, metrics: null, deployable: false };
        const bytes = JSON.stringify({ ...body, fingerprint: sha(canonicalContextJson(body)) }, null, 2) + '\n';
        if (Buffer.byteLength(bytes) > 33554432) throw Error('detail_file_limit');
        await destination.writeFile(bytes, 'utf8');
        console.log(JSON.stringify({ status: 'candidates_reconciled', artifactSha256: sha(bytes), coverage: report.coverage,
          assessments: report.assessments, metrics: null, deployable: false }));
      } finally { await destination.close(); }
    }
  }
} catch (error) {
  const allowed = ['discovery_file_sha_mismatch', 'discovery_union_replay_mismatch', 'detail_source_binding_invalid',
    'detail_capture_binding_invalid', 'detail_assessment_replay_mismatch', 'detail_unmanifested_receipt', 'detail_reconciliation_replay_mismatch', 'detail_inventory_limit'];
  console.error(JSON.stringify({ status: 'unavailable', code: error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' :
    allowed.includes(error?.message) ? error.message.toUpperCase() : 'EVALUATION_DETAILS_REJECTED', importMayHaveCommitted: importCommitted,
    message: error?.code === 'EEXIST' ? 'Путь уже существует; предыдущая запись сохранена.' :
      'Операция не завершена. Проверьте SHA и сохранённые файлы; перед повтором импорта проверьте его журнал и состояние БД.' }));
  process.exitCode = 1;
} finally { await runtime?.close(); await db?.destroy(); }
