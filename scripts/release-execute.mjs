import { open } from 'node:fs/promises';
import { createDatabase, V1DataRepository, canonicalContextJson, V1ReleaseEvaluationJournal } from '../packages/db/dist/index.js';
import { ResearchJournalRevisionSchema } from '../packages/contracts/dist/index.js';
import { assertV1ReleaseCaptureTime, freezeV1ReleaseCapture, prepareV1ReleaseEvidence, verifyV1ReleaseCapture,
  evaluateV1ReleaseCapture } from '../packages/ingestion/dist/index.js';
import { bounded, sha } from './lib/evaluation-discovery-files.mjs';
import { readReleaseFiles, verifyReleaseContext, loadReleaseEvidence, releaseExecutionCode } from './lib/v1-release-files.mjs';
const [mode, configPath, configSha, fourth, fifth, ...extra] = process.argv.slice(2);
if (!configPath || !/^[a-f0-9]{64}$/.test(configSha ?? '') ||
  (mode === 'check' ? fourth !== undefined || fifth !== undefined || extra.length :
    mode === 'capture' ? !fourth || fifth !== undefined || extra.length :
    ['verify', 'evaluate', 'revise'].includes(mode) ? !fourth || !/^[a-f0-9]{64}$/.test(fifth ?? '') ||
      (mode === 'verify' ? extra.length !== 0 : mode === 'evaluate' ? extra.length !== 1 : extra.length !== 3 || !/^[a-f0-9]{64}$/.test(extra[1])) : true)) {
  console.error('Использование: check config.json SHA | capture config.json SHA new-capture.json | verify config.json SHA capture.json CAPTURE_SHA | evaluate config.json SHA capture.json CAPTURE_SHA new-report.json | revise config.json SHA capture.json CAPTURE_SHA revision.json REVISION_SHA new-report.json');
  process.exit(2);
}
let db, output, committedJournal, journalMayHaveCommitted = false;
try {
  const loaded = await readReleaseFiles(configPath, configSha), now = new Date().toISOString();
  if (mode !== 'check') assertV1ReleaseCaptureTime(loaded.plan, now); // Before candidate/evidence/capture reads or DB/output.
  const context = await verifyReleaseContext(loaded), { plan, candidate, files, filesSha256, freeze } = context;
  if (mode === 'check') {
    console.log(JSON.stringify({ status: 'release_capture_config_verified', planFingerprint: plan.fingerprint,
      candidateFingerprint: candidate.fingerprint, evaluateNotBefore: plan.evaluateNotBefore,
      captureAllowedNow: now >= plan.evaluateNotBefore, scoringImplemented: true,
      sourceEvidenceChecked: false, executableFreezeComplete: !!freeze, deployable: false, teamAWinProbability: null }));
  } else {
    const { ledger, batches } = await loadReleaseEvidence(context), code = await releaseExecutionCode();
    let capture, binding, artifactSha, evaluated;
    if (mode === 'capture') {
      if (!process.env.DATABASE_URL) throw Error('release_database_required');
      output = await open(fourth, 'wx'); db = createDatabase(process.env.DATABASE_URL);
      const inventory = await new V1DataRepository(db).exportReleaseInventory({ fromAt: plan.request.warmupFromAt,
        toAt: plan.request.snapshotAt, snapshotAt: plan.request.snapshotAt, maxMaps: plan.request.maxInventoryMaps }, code);
      capture = freezeV1ReleaseCapture(plan, candidate, inventory, ledger, batches, new Date().toISOString(), files, filesSha256, code, freeze);
      binding = prepareV1ReleaseEvidence(plan, candidate, inventory, ledger, batches);
      const bytes = JSON.stringify(capture, null, 2) + '\n';
      if (Buffer.byteLength(bytes) > 67108864) throw Error('release_capture_file_limit');
      await output.writeFile(bytes, 'utf8'); await output.sync(); artifactSha = sha(bytes);
    } else {
      const saved = await bounded(fourth, 67108864, fifth);
      const verified = verifyV1ReleaseCapture(plan, candidate, saved.data, ledger, batches, now);
      ({ capture, binding } = verified);
      if (capture.filesSha256 !== filesSha256 || canonicalContextJson(capture.files) !== canonicalContextJson(files) ||
        canonicalContextJson(capture.executableFreeze ?? null) !== canonicalContextJson(freeze ?? null) ||
        canonicalContextJson(capture.executionCode) !== canonicalContextJson(code)) throw Error('release_capture_context_mismatch');
      artifactSha = sha(saved.bytes);
      if (mode === 'evaluate' || mode === 'revise') {
        const revision = mode === 'revise' ? ResearchJournalRevisionSchema.parse((await bounded(extra[0], 65536, extra[1])).data) : null;
        if (!process.env.DATABASE_URL) throw Error('release_database_required');
        output = await open(extra.at(-1), 'wx'); db = createDatabase(process.env.DATABASE_URL);
        journalMayHaveCommitted = true;
        const recorded = await new V1ReleaseEvaluationJournal(db).evaluate({ planSha256: files.planSha256,
          planFingerprint: plan.fingerprint, captureSha256: artifactSha,
          captureText: new TextDecoder('utf-8', { fatal: true }).decode(saved.bytes), scorerCode: code, revision },
          () => evaluateV1ReleaseCapture(plan, candidate, capture, ledger, batches, now));
        evaluated = recorded.artifact.report;
        committedJournal = { ...recorded.artifact.journal, status: recorded.status, reportSha256: recorded.sha256 };
        await output.writeFile(recorded.bytes, 'utf8'); await output.sync(); artifactSha = recorded.sha256;
      }
    }
    console.log(JSON.stringify({ status: evaluated?.evaluation.status ?? (mode === 'capture' ? 'release_source_captured' : 'release_capture_verified'),
      fingerprint: capture.fingerprint, artifactSha256: artifactSha, bindingFingerprint: binding.fingerprint,
      journal: committedJournal, coverage: evaluated?.coverage ?? binding.coverage, discoveryStatus: binding.discoveryStatus, remoteCompleteness: 'unknown',
      evaluation: evaluated?.evaluation ?? 'not_performed', executableFreezeComplete: !!freeze,
      releaseGatePassed: evaluated?.releaseGatePassed ?? false, deployable: false, teamAWinProbability: null }));
    if (evaluated?.evaluation.status === 'unavailable') process.exitCode = 3;
  }
} catch (error) {
  const safe = ['release_capture_too_early', 'release_clock_invalid', 'release_database_required', 'release_evidence_scope',
    'release_inventory_scope', 'release_detail_batches', 'release_discovery_scope', 'release_capture_file_limit',
    'release_capture_replay_mismatch', 'release_capture_context_mismatch', 'release_capture_in_future',
    'release_reviewed_history_missing', 'v1_candidate_replay_mismatch', 'discovery_file_sha_mismatch',
    'journal_revision_required', 'journal_parent_changed', 'journal_parent_missing', 'journal_revision_conflict',
    'journal_plan_sha_changed', 'journal_time_gate', 'journal_stored_hash_mismatch'];
  console.error(JSON.stringify({ status: 'unavailable', code: error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' :
    safe.includes(error?.message) ? error.message.toUpperCase() : 'RELEASE_CAPTURE_REJECTED',
    journalMayHaveCommitted, journal: committedJournal,
    message: committedJournal ? 'Результат сохранён в БД. Восстановите файл командой release:journal export в новый путь.' :
      journalMayHaveCommitted ? 'Проверьте release:journal list: результат мог сохраниться. Повтор тех же входов безопасен; пересмотр требует родителя и причины.' :
        'Запуск release отклонён. Проверьте дату плана, SHA источников, полноту batch-файлов, версию кода и новый путь.' }));
  process.exitCode = 1;
} finally { await output?.close(); await db?.destroy(); }
