import { createHash } from 'node:crypto';
import { V1JournalReportSchema, JournalledV1ReleaseReportSchema, V1ReleaseCaptureSchema,
  V1ReleaseJournalRequestSchema, ResearchJournalIdentitySchema } from '@dota/contracts';
import { sql, type Db } from './index.js';
import { canonicalContextJson } from './temporal.js';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hash = (v: unknown) => sha(canonicalContextJson(v));
const maxBytes = 67108864;
type Row = { plan_fingerprint: string; plan_sha256: string; revision: number; parent_revision: number | null;
  parent_report_sha256: string | null; revision_reason: string | null; capture_sha256: string; scorer_sha256: string;
  capture_text: string; report_text: string; report_sha256: string; evaluation_status: string; recorded_at: Date };

function validateCapture(text: string, expected: string, planFingerprint: string) {
  if (Buffer.byteLength(text) > maxBytes || sha(text) !== expected) throw Error('journal_capture_hash_mismatch');
  const capture = V1ReleaseCaptureSchema.parse(JSON.parse(text));
  const { fingerprint, ...body } = capture;
  const { fingerprint: inventoryHash, ...inventory } = capture.inventory;
  if (hash(body) !== fingerprint || hash(inventory) !== inventoryHash ||
    capture.planFingerprint !== planFingerprint || capture.capturedAt < inventory.source.request.snapshotAt)
    throw Error('journal_capture_binding');
  if (capture.executableFreezeComplete !== !!capture.executableFreeze || !!capture.files.freeze !== !!capture.executableFreeze)
    throw Error('journal_freeze_binding');
  if (capture.executableFreeze) {
    const { fingerprint: freezeHash, ...freeze } = capture.executableFreeze;
    if (hash(freeze) !== freezeHash || freeze.planFingerprint !== capture.planFingerprint ||
      freeze.candidateFingerprint !== capture.candidateFingerprint || freeze.planSha256 !== capture.files.planSha256 ||
      freeze.candidateSha256 !== capture.files.candidateSha256 || canonicalContextJson(freeze.code) !== canonicalContextJson(capture.executionCode) ||
      freeze.registeredAt >= freeze.testFromAt || freeze.evaluateNotBefore !== inventory.source.request.snapshotAt ||
      freeze.syntheticOnly !== inventory.source.syntheticOnly) throw Error('journal_freeze_binding');
  }
  return capture;
}

function checkFreeze(report: ReturnType<typeof V1JournalReportSchema.parse>, capture: ReturnType<typeof validateCapture>) {
  if (report.executableFreezeComplete !== capture.executableFreezeComplete) throw Error('journal_freeze_binding');
  if (report.format === 'v1-release-evaluation-v2' && (!capture.executableFreeze ||
    report.freezeFingerprint !== capture.executableFreeze.fingerprint || report.freezeSha256 !== capture.files.freeze?.sha256 ||
    canonicalContextJson(report.scorerCode) !== canonicalContextJson(capture.executableFreeze.code))) throw Error('journal_freeze_binding');
}

function checked(row: Row) {
  if (sha(row.report_text) !== row.report_sha256 || sha(row.capture_text) !== row.capture_sha256) throw Error('journal_stored_hash_mismatch');
  const artifact = JournalledV1ReleaseReportSchema.parse(JSON.parse(row.report_text));
  const { fingerprint, ...body } = artifact;
  if (hash(body) !== fingerprint) throw Error('journal_stored_hash_mismatch');
  const capture = validateCapture(row.capture_text, row.capture_sha256, row.plan_fingerprint);
  checkFreeze(artifact.report, capture);
  const { fingerprint: reportHash, ...report } = artifact.report;
  if (hash(report) !== reportHash || report.planFingerprint !== row.plan_fingerprint || report.executionFingerprint !== capture.fingerprint ||
    hash(report.scorerCode) !== row.scorer_sha256 || report.candidateFingerprint !== capture.candidateFingerprint ||
    report.bindingFingerprint !== capture.bindingFingerprint || row.plan_sha256 !== capture.files.planSha256 ||
    report.evaluation.syntheticOnly !== capture.inventory.source.syntheticOnly) throw Error('journal_stored_binding_mismatch');
  const expected = { planSha256: row.plan_sha256, planFingerprint: row.plan_fingerprint, revision: row.revision,
    parentRevision: row.parent_revision, parentReportSha256: row.parent_report_sha256, reason: row.revision_reason,
    captureSha256: row.capture_sha256, scorerSha256: row.scorer_sha256, recordedAt: row.recorded_at.toISOString() };
  if (canonicalContextJson(expected) !== canonicalContextJson(artifact.journal) || artifact.report.evaluation.status !== row.evaluation_status)
    throw Error('journal_stored_binding_mismatch');
  return { artifact, bytes: row.report_text, sha256: row.report_sha256, captureText: row.capture_text };
}

/** One committed result per input/code pair; publish only after this transaction returns. */
export class V1ReleaseEvaluationJournal {
  constructor(private readonly db: Db) {}
  async evaluate(input: unknown, score: () => unknown | Promise<unknown>) {
    const request = V1ReleaseJournalRequestSchema.parse(input);
    const capture = validateCapture(request.captureText, request.captureSha256, request.planFingerprint);
    if (request.planSha256 !== capture.files.planSha256) throw Error('journal_plan_sha_changed');
    if (new Set(request.scorerCode.map(c => c.path)).size !== request.scorerCode.length) throw Error('journal_duplicate_code');
    const scorerSha = hash(request.scorerCode);
    return this.db.transaction().execute(async tx => {
      await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-release-evaluation:' + request.planFingerprint},0))`.execute(tx);
      const now = (await sql<{ now: string }>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`.execute(tx)).rows[0]!.now;
      if (now < capture.inventory.source.request.snapshotAt || capture.capturedAt > now) throw Error('journal_time_gate');
      const latest = (await sql<Row>`SELECT * FROM v1_release_evaluation_journal WHERE plan_fingerprint=${request.planFingerprint}
        ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
      if (latest && latest.plan_sha256 !== request.planSha256) throw Error('journal_plan_sha_changed');
      const existing = (await sql<Row>`SELECT * FROM v1_release_evaluation_journal WHERE plan_fingerprint=${request.planFingerprint}
        AND capture_sha256=${request.captureSha256} AND scorer_sha256=${scorerSha}`.execute(tx)).rows[0];
      if (existing) {
        if (request.revision && (request.revision.parentRevision !== existing.parent_revision ||
          request.revision.parentReportSha256 !== existing.parent_report_sha256 || request.revision.reason !== existing.revision_reason))
          throw Error('journal_revision_conflict');
        return { status: 'already_recorded' as const, ...checked(existing) };
      }
      if (latest) {
        if (!request.revision) throw Error('journal_revision_required');
        if (request.revision.parentRevision !== latest.revision || request.revision.parentReportSha256 !== latest.report_sha256)
          throw Error('journal_parent_changed');
      } else if (request.revision) throw Error('journal_parent_missing');
      // Errors roll back. No output escapes before both computation and persistence succeed.
      const report = V1JournalReportSchema.parse(await score()), { fingerprint: reportHash, ...reportBody } = report;
      checkFreeze(report, capture);
      if (report.executionFingerprint !== capture.fingerprint || report.planFingerprint !== request.planFingerprint || hash(reportBody) !== reportHash ||
        canonicalContextJson(report.scorerCode) !== canonicalContextJson(request.scorerCode) ||
        report.candidateFingerprint !== capture.candidateFingerprint || report.bindingFingerprint !== capture.bindingFingerprint ||
        report.evaluation.syntheticOnly !== capture.inventory.source.syntheticOnly) throw Error('journal_report_binding');
      const journal = ResearchJournalIdentitySchema.parse({ planSha256: request.planSha256, planFingerprint: request.planFingerprint,
        revision: (latest?.revision ?? 0) + 1, parentRevision: latest?.revision ?? null, parentReportSha256: latest?.report_sha256 ?? null,
        reason: request.revision?.reason ?? null, captureSha256: request.captureSha256, scorerSha256: scorerSha, recordedAt: now });
      const body = { schemaVersion: 1, format: 'journalled-v1-release-report-v1', journal, report };
      const artifact = JournalledV1ReleaseReportSchema.parse({ ...body, fingerprint: hash(body) });
      const bytes = JSON.stringify(artifact, null, 2) + '\n', reportSha = sha(bytes);
      if (Buffer.byteLength(bytes) > maxBytes) throw Error('journal_report_limit');
      const row = (await sql<Row>`INSERT INTO v1_release_evaluation_journal(plan_fingerprint,plan_sha256,revision,parent_revision,parent_report_sha256,
        revision_reason,capture_sha256,scorer_sha256,capture_text,report_text,report_sha256,evaluation_status,recorded_at)
        VALUES (${journal.planFingerprint},${journal.planSha256},${journal.revision},${journal.parentRevision},${journal.parentReportSha256},
          ${journal.reason},${journal.captureSha256},${journal.scorerSha256},${request.captureText},${bytes},${reportSha},${report.evaluation.status},${now}::timestamptz)
        RETURNING *`.execute(tx)).rows[0]!;
      return { status: 'recorded' as const, ...checked(row) };
    });
  }

  async read(planFingerprint: string, revision: number) {
    if (!/^[a-f0-9]{64}$/.test(planFingerprint) || !Number.isSafeInteger(revision) || revision < 1 || revision > 2147483647)
      throw Error('journal_lookup_invalid');
    const row = (await sql<Row>`SELECT * FROM v1_release_evaluation_journal WHERE plan_fingerprint=${planFingerprint} AND revision=${revision}`.execute(this.db)).rows[0];
    if (!row) throw Error('journal_not_found');
    return checked(row);
  }

  async list(planFingerprint: string) {
    if (!/^[a-f0-9]{64}$/.test(planFingerprint)) throw Error('journal_lookup_invalid');
    const rows = (await sql<{ revision: number; parentRevision: number | null; reportSha256: string; captureSha256: string;
      scorerSha256: string; status: string; recordedAt: Date; reason: string | null }>`SELECT revision,parent_revision AS "parentRevision",
      report_sha256 AS "reportSha256",capture_sha256 AS "captureSha256",scorer_sha256 AS "scorerSha256",evaluation_status AS status,
      recorded_at AS "recordedAt",revision_reason AS reason FROM v1_release_evaluation_journal
      WHERE plan_fingerprint=${planFingerprint} ORDER BY revision LIMIT 1001`.execute(this.db)).rows;
    if (rows.length > 1000) throw Error('journal_list_limit');
    return rows.map(r => ({ ...r, recordedAt: r.recordedAt.toISOString() }));
  }
}
