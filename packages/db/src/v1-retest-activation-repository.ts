import { RetestTransitionSchema, RetestRegistryMetadataSchema } from '@dota/contracts';
import { sql, type Db, type Executor } from './index.js';
import { RetestModelRegistry } from './v1-retest-registry-repository.js';
import { readRetestRuntimeCode } from './v1-retest-runtime-code.js';
import { registryHash, registrySha } from './v1-registry.js';
const active = async (db: Executor) => (await sql<{ id: string }>`SELECT id FROM prediction_model_versions WHERE stage='pre_match' AND is_active`.execute(db)).rows[0]?.id ?? null;
type Header = { model_id: string; metadata: unknown; protocol_fingerprint: string; freeze_sha256: string; report_sha256: string;
  stage: string; algorithm: string; artifact_sha256: string; is_active: boolean };
const header = async (db: Executor, id: string) => {
  const row = (await sql<Header>`SELECT a.model_id,a.metadata,a.protocol_fingerprint,a.freeze_sha256,a.report_sha256,
    m.stage,m.algorithm,m.artifact_sha256,m.is_active FROM v1_retest_model_artifacts a JOIN prediction_model_versions m ON m.id=a.model_id
    WHERE a.model_id=${id}::uuid`.execute(db)).rows[0];
  if (!row) throw Error('retest_registry_model_missing');
  const metadata = RetestRegistryMetadataSchema.parse(row.metadata);
  if (row.stage !== metadata.stage || row.algorithm !== metadata.algorithm || row.artifact_sha256 !== row.freeze_sha256 ||
    row.protocol_fingerprint !== metadata.protocolFingerprint) throw Error('retest_registry_model_binding');
  return { ...row, metadata };
};
export class RetestActivationRegistry {
  constructor(private readonly db: Db) {}
  async transition(input: unknown) {
    const request = RetestTransitionSchema.parse(input), requestHash = registryHash(request);
    const recorded = (await sql`SELECT 1 FROM model_activation_events WHERE retest_request_id=${request.requestId}`.execute(this.db)).rows.length > 0;
    // Full replay at promotion/rollback; never rerun a 664-map backtest for each HTTP request.
    const beforeCode = request.modelId && !recorded ? JSON.stringify(await readRetestRuntimeCode()) : null;
    const verified = request.modelId && !recorded ? await new RetestModelRegistry(this.db).verify(request.modelId) : null;
    const code = request.modelId && !recorded ? JSON.stringify(await readRetestRuntimeCode()) : null;
    if (beforeCode !== code) throw Error('retest_registry_runtime_changed');
    return this.db.transaction().execute(async tx => {
      await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('model-registry:pre_match',0))`.execute(tx);
      const previous = (await sql<{ id: string; retest_request_hash: string }>`SELECT id,retest_request_hash FROM model_activation_events WHERE retest_request_id=${request.requestId}`.execute(tx)).rows[0];
      if (previous) {
        if (previous.retest_request_hash !== requestHash) throw Error('retest_registry_request_conflict');
        return { status: 'already_recorded' as const, eventId: previous.id, activeModelId: await active(tx) };
      }
      if (code !== null && code !== JSON.stringify(await readRetestRuntimeCode())) throw Error('retest_registry_runtime_changed');
      if (await active(tx) !== request.expectedCurrentId) throw Error('retest_registry_current_changed');
      if (request.modelId && request.evidence && verified) {
        const model = await header(tx, request.modelId);
        if (registryHash(model.metadata) !== registryHash(verified.metadata) || model.report_sha256 !== verified.reportSha256 ||
          model.protocol_fingerprint !== request.evidence.protocolFingerprint || model.report_sha256 !== request.evidence.reportSha256 ||
          model.freeze_sha256 !== request.evidence.freezeSha256) throw Error('retest_registry_activation_binding');
      }
      const row = (await sql<{ id: string }>`INSERT INTO model_activation_events(stage,event_type,previous_model_id,activated_model_id,actor,reason,
        retest_request_id,retest_request_hash,retest_protocol_fingerprint,retest_freeze_sha256,retest_report_sha256,retest_runtime_text,retest_runtime_sha256)
        VALUES ('pre_match',${request.action},${request.expectedCurrentId},${request.modelId},'owner',${request.reason},${request.requestId},${requestHash},
          ${request.evidence?.protocolFingerprint ?? null},${request.evidence?.freezeSha256 ?? null},${request.evidence?.reportSha256 ?? null},
          ${code},${code === null ? null : registrySha(code)}) RETURNING id`.execute(tx)).rows[0]!;
      return { status: 'recorded' as const, eventId: row.id, activeModelId: await active(tx) };
    });
  }
  async events() {
    const rows = (await sql`SELECT id,registry_sequence::text AS sequence,event_type AS action,
      previous_model_id AS "previousModelId",activated_model_id AS "modelId",retest_request_id AS "requestId",
      retest_report_sha256 AS "reportSha256",retest_runtime_sha256 AS "runtimeSha256",reason
      FROM model_activation_events WHERE retest_request_id IS NOT NULL ORDER BY registry_sequence LIMIT 1001`.execute(this.db)).rows;
    if (rows.length > 1000) throw Error('retest_registry_list_limit');
    return rows;
  }
  /** The caller holds the common registry lock until the prediction snapshot is stored. */
  async lockForPrediction(tx: Executor, id: string) {
    try {
      const model = await header(tx, id);
      const event = (await sql<{ id: string; activated_model_id: string | null; retest_report_sha256: string;
        retest_freeze_sha256: string; retest_protocol_fingerprint: string; retest_runtime_text: string; retest_runtime_sha256: string }>`SELECT * FROM model_activation_events
        WHERE stage='pre_match' ORDER BY registry_sequence DESC LIMIT 1`.execute(tx)).rows[0];
      if (!model.is_active || !event || event.activated_model_id !== id || event.retest_report_sha256 !== model.report_sha256 ||
        event.retest_freeze_sha256 !== model.freeze_sha256 || event.retest_protocol_fingerprint !== model.protocol_fingerprint ||
        !event.retest_runtime_text || registrySha(event.retest_runtime_text) !== event.retest_runtime_sha256)
        throw Error('retest_registry_active_evidence');
      if (registrySha(JSON.stringify(await readRetestRuntimeCode())) !== event.retest_runtime_sha256) throw Error('retest_registry_runtime_changed');
      return { status: 'model_eligible' as const, kind: 'retest' as const, modelId: id, activationEventId: event.id,
        reportSha256: model.report_sha256, freezeSha256: model.freeze_sha256, metadata: model.metadata,
        runtimeSha256: event.retest_runtime_sha256, teamAWinProbability: null };
    } catch {
      return { status: 'unavailable' as const, reason: 'ACTIVE_MODEL_EVIDENCE_INVALID', modelId: id, teamAWinProbability: null };
    }
  }
}
