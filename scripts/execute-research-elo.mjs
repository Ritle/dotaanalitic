import { open, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ResearchJournalRevisionSchema } from '../packages/contracts/dist/index.js';
import { readResearchEvidence, loadResearchEvidence } from './lib/research-evidence-files.mjs';
import { freezeEvidenceResearchExecution, evaluateEvidenceResearchExecution } from '../packages/ingestion/dist/index.js';
import { createDatabase, ResearchEloRepository, verifyResearchExecutionPlan, researchExecutionRequest,
  assertResearchExecutionTime, ResearchEvaluationJournal } from '../packages/db/dist/index.js';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function read(path, limit, expected, raw = false) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) throw Error('execution_file_limit');
    const bytes = Buffer.alloc(limit + 1); let count = 0;
    while (count < bytes.length) { const part = await file.read(bytes, count, bytes.length - count, null); if (!part.bytesRead) break; count += part.bytesRead; }
    if (count > limit) throw Error('execution_file_limit');
    const content = bytes.subarray(0, count);
    if (sha(content) !== expected) throw Error('execution_source_sha_mismatch');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content), data = JSON.parse(text);
    return raw ? { text, data } : data;
  } finally { await file.close(); }
}
async function codeManifest() {
  const paths = ['scripts/execute-research-elo.mjs', 'scripts/research-journal.mjs', 'scripts/lib/research-evidence-files.mjs',
    'scripts/lib/evaluation-discovery-files.mjs', 'scripts/lib/evaluation-detail-files.mjs', 'package.json', 'pnpm-lock.yaml'];
  for (const directory of ['packages/contracts/dist', 'packages/analytics/dist', 'packages/db/dist', 'packages/ingestion/dist', 'packages/db/migrations']) {
    for (const name of (await readdir(new URL('../' + directory + '/', import.meta.url), { recursive: true })).sort())
      if (name.endsWith('.js') || name.endsWith('.sql')) paths.push(directory + '/' + name.replaceAll('\\', '/'));
  }
  return Promise.all(paths.sort().map(async path => ({ path, sha256: sha(await readFile(new URL('../' + path, import.meta.url))) })));
}
const [mode, planPath, planSha, priorPath, discoveryPath, ...rest] = process.argv.slice(2);
if (!planPath || !/^[a-f0-9]{64}$/.test(planSha ?? '') || !priorPath || !discoveryPath ||
  (mode === 'check' ? rest.length !== 0 : mode === 'evidence' ? rest.length !== 2 || !/^[a-f0-9]{64}$/.test(rest[1]) :
    mode === 'capture' ? rest.length !== 3 || !/^[a-f0-9]{64}$/.test(rest[1]) :
    mode === 'evaluate' ? rest.length !== 3 || !/^[a-f0-9]{64}$/.test(rest[1]) :
      mode === 'revise' ? rest.length !== 5 || ![rest[1], rest[3]].every(s => /^[a-f0-9]{64}$/.test(s)) : true)) {
  console.error('Использование: check|evidence|capture|evaluate|revise plan.json SHA256 prior.json discovery.json [evidence.json SHA256 | evidence.json SHA256 new-capture.json | capture.json SHA256 new-report.json | capture.json SHA256 revision.json REVISION_SHA256 new-report.json]');
  process.exit(2);
}
let db, destination, journalMayHaveCommitted = false, committedJournal;
try {
  const saved = await read(planPath, 4194304, planSha);
  const prior = await read(priorPath, 33554432, saved?.request?.priorExportSha256);
  const discovery = await read(discoveryPath, 8388608, saved?.request?.discoverySha256);
  const plan = verifyResearchExecutionPlan(saved, prior, discovery), now = new Date().toISOString();
  if (mode === 'check') {
    console.log(JSON.stringify({ status: 'plan_verified', planFingerprint: plan.fingerprint,
      evaluationNotBefore: plan.request.evaluationNotBefore, timeGateOpen: now >= plan.request.evaluationNotBefore,
      request: researchExecutionRequest(plan), metrics: null, releaseGate: 'not_assessed', trainingReady: false, deployable: false }));
  } else if (mode === 'evidence') {
    const evidence = await readResearchEvidence(rest[0], rest[1], planSha);
    console.log(JSON.stringify({ status: 'research_evidence_verified', discoveryFingerprint: evidence.ledger.fingerprint,
      observedTargets: evidence.ledger.summary.possibleTargetMaps, batches: evidence.batches.length,
      discoveryStatus: evidence.ledger.status, remoteCompleteness: 'unknown', metrics: null, deployable: false }));
  } else {
    // Must precede connection, source capture read and any metric calculation. No CLI clock override.
    assertResearchExecutionTime(plan, now);
    let artifact, bytes;
    if (mode === 'capture') {
      const evidence = await readResearchEvidence(rest[0], rest[1], planSha);
      if (!process.env.DATABASE_URL) throw Error('execution_database_required');
      const code = await codeManifest();
      // Legacy snapshot schema permits 12 references; the full executable manifest lives in the outer envelope.
      const snapshotCode = code.filter(c => ['packages/db/dist/research-elo.js', 'packages/db/dist/research-elo-repository.js',
        'packages/db/dist/identity.js', 'packages/db/dist/identity-repository.js', 'packages/db/dist/outcome-verifier.js',
        'packages/db/dist/dataset-splits.js', 'packages/db/dist/temporal.js', 'packages/contracts/dist/research-elo.js',
        'packages/analytics/dist/elo.js', 'scripts/execute-research-elo.mjs',
        'packages/db/migrations/012_verified_dataset_boundary.sql', 'packages/db/migrations/018_outcome_verifier.sql'].includes(c.path));
      db = createDatabase(process.env.DATABASE_URL);
      const snapshot = await new ResearchEloRepository(db).export(researchExecutionRequest(plan), snapshotCode);
      artifact = freezeEvidenceResearchExecution(plan, snapshot, new Date().toISOString(), code, evidence.files, evidence.ledger, evidence.batches);
    } else {
      const { data: capture, text: captureText } = await read(rest[0], 67108864, rest[1], true);
      const evidence = await loadResearchEvidence(capture?.evidence, planSha);
      const revision = mode === 'revise' ? ResearchJournalRevisionSchema.parse(await read(rest[2], 65536, rest[3])) : null;
      if (!process.env.DATABASE_URL) throw Error('execution_database_required');
      const scorerCode = await codeManifest();
      const { canonicalContextJson } = await import('../packages/db/dist/index.js');
      // Reserve output before computing; a later disk failure is recoverable from the committed journal.
      destination = await open(rest.at(-1), 'wx');
      db = createDatabase(process.env.DATABASE_URL);
      journalMayHaveCommitted = true;
      const result = await new ResearchEvaluationJournal(db).evaluate({ planSha256: planSha, planFingerprint: plan.fingerprint,
        captureSha256: rest[1], captureText, scorerCode, revision }, () => {
        const evaluation = evaluateEvidenceResearchExecution(plan, capture, evidence.ledger, evidence.batches, now);
        const { fingerprint: _previous, ...body } = { ...evaluation, scorerCode };
        return { ...body, fingerprint: sha(canonicalContextJson(body)) };
      });
      artifact = result.artifact; bytes = result.bytes;
      committedJournal = { ...artifact.journal, status: result.status, reportSha256: result.sha256 };
    }
    bytes ??= JSON.stringify(artifact, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > 67108864) throw Error('execution_file_limit');
    destination ??= await open(rest.at(-1), 'wx');
    await destination.writeFile(bytes, 'utf8'); await destination.sync();
    const evaluated = artifact.report ?? artifact;
    console.log(JSON.stringify({ status: mode === 'capture' ? 'research_captured' : evaluated.evaluation.status,
      artifactSha256: sha(bytes), fingerprint: artifact.fingerprint, candidateMaps: artifact.execution?.snapshot.candidates.length,
      journal: committedJournal, coverage: evaluated.coverage,
      summary: evaluated.evaluation?.summary, metrics: evaluated.evaluation?.metrics ?? null,
      releaseGate: 'not_assessed', trainingReady: false, deployable: false }));
    if (evaluated.evaluation?.status === 'unavailable') process.exitCode = 3;
  }
} catch (error) {
  const allowed = ['execution_too_early', 'execution_source_sha_mismatch', 'execution_plan_replay_mismatch',
    'execution_request_mismatch', 'execution_warmup_missing_or_changed', 'execution_unregistered_warmup',
    'execution_inventory_limit', 'research_inventory_limit', 'research_fact_inventory_limit', 'execution_evidence_scope',
    'execution_evidence_batches', 'execution_evidence_horizon', 'execution_evidence_batch_binding', 'execution_evidence_replay',
    'journal_revision_required', 'journal_parent_changed', 'journal_parent_missing', 'journal_revision_conflict',
    'journal_plan_sha_changed', 'journal_time_gate', 'journal_stored_hash_mismatch'];
  console.error(JSON.stringify({ status: 'unavailable', code: error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' :
    allowed.includes(error?.message) ? error.message.toUpperCase() : 'RESEARCH_EXECUTION_REJECTED',
    journalMayHaveCommitted, journal: committedJournal,
    message: error?.code === 'EEXIST' ? 'Файл уже существует; сохранённый результат не изменён.' :
      error?.message === 'execution_too_early' ? 'Оценка ещё закрыта по зарегистрированному времени плана.' :
        committedJournal ? 'Результат сохранён в БД, но файл не записан. Восстановите его командой research:journal export в новый путь.' :
          journalMayHaveCommitted ? 'Проверьте research:journal list перед повтором: результат мог сохраниться. Повтор тех же входов безопасен; ревизия требует родителя и причины.' :
            'Запуск отклонён. Проверьте SHA плана и источников, фиксированные даты и полный локальный состав карт.' }));
  process.exitCode = 1;
} finally { await destination?.close(); await db?.destroy(); }
