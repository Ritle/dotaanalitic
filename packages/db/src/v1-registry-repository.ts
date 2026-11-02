import { randomUUID } from 'node:crypto';
import { V1RegistryTransitionSchema } from '@dota/contracts';
import { sql, type Db, type Executor, type Transaction, type Database } from './index.js';
import { V1ReleaseEvaluationJournal } from './v1-release-journal.js';
import { registryHash, verifyV1RegistryArtifact, verifyV1RegistryRelease } from './v1-registry.js';
type ModelRow = { id: string; stage: string; algorithm: string; is_active: boolean; artifact_sha256: string;
  plan_text: string; candidate_text: string; freeze_text: string; plan_sha256: string; candidate_sha256: string; freeze_sha256: string };
type EventRow = { id: string; sequence: string; action: string; previousModelId: string | null; modelId: string | null;
  requestId: string; requestHash: string; reportSha256: string | null; reason: string };
const eventColumns = sql`id,registry_sequence::text AS sequence,event_type AS action,previous_model_id AS "previousModelId",
  activated_model_id AS "modelId",v1_request_id AS "requestId",v1_request_hash AS "requestHash",v1_report_sha256 AS "reportSha256",reason`;
async function current(db: Executor) {
  return (await sql<{ id: string }>`SELECT id FROM prediction_model_versions WHERE stage='pre_match' AND is_active`.execute(db)).rows[0]?.id ?? null;
}
const now = async (db: Executor) => (await sql<{ value: Date }>`SELECT clock_timestamp() AS value`.execute(db)).rows[0]!.value.toISOString();

export class V1ModelRegistry {
  constructor(private readonly db: Db) {}
  async register(input: unknown) {
    const artifact = verifyV1RegistryArtifact(input), { bytes, candidate, plan, freeze } = artifact;
    return this.db.transaction().execute(async tx => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('model-registry:pre_match',0))`.execute(tx);
      if (freeze.registeredAt > await now(tx)) throw Error('registry_time_gate');
      const existing = (await sql<{ model_id: string; freeze_sha256: string }>`SELECT model_id,freeze_sha256 FROM v1_model_artifacts
        WHERE freeze_fingerprint=${freeze.fingerprint} OR freeze_sha256=${bytes.freezeSha256}`.execute(tx)).rows[0];
      if (existing) {
        const saved = await this.load(existing.model_id, tx);
        if (registryHash(saved.artifact.bytes) !== registryHash(bytes)) throw Error('registry_registration_conflict');
        return { status: 'already_registered' as const, modelId: existing.model_id, isActive: saved.row.is_active };
      }
      const id = randomUUID();
      await sql`INSERT INTO prediction_model_versions(id,stage,version,algorithm,feature_schema_version,artifact_uri,
        artifact_sha256,trained_at,training_cutoff,train_start_at,train_end_at,test_start_at,test_end_at,hyperparameters,dataset_fingerprint)
        VALUES (${id},'pre_match',${'v1-' + freeze.fingerprint},'fixed_player_mean_elo',${candidate.featurePolicy.version},
          ${'v1-registry:' + id},${bytes.candidateSha256},${candidate.registration.kernelRegisteredAt}::timestamptz,
          ${plan.testFromAt}::timestamptz,${plan.request.warmupFromAt}::timestamptz,${plan.testFromAt}::timestamptz,
          ${plan.testFromAt}::timestamptz,${plan.request.events.map(e => e.until).sort().at(-1)!}::timestamptz,
          ${JSON.stringify({ fit: candidate.fit, featurePolicy: candidate.featurePolicy, evaluationBasis: 'conditional_actual_lineups_reconstructed' })}::jsonb,
          ${plan.developmentFingerprint})`.execute(tx);
      await sql`INSERT INTO v1_model_artifacts(model_id,plan_fingerprint,candidate_fingerprint,freeze_fingerprint,
        plan_text,candidate_text,freeze_text,plan_sha256,candidate_sha256,freeze_sha256)
        VALUES (${id},${plan.fingerprint},${candidate.fingerprint},${freeze.fingerprint},${bytes.planText},${bytes.candidateText},
          ${bytes.freezeText},${bytes.planSha256},${bytes.candidateSha256},${bytes.freezeSha256})`.execute(tx);
      return { status: 'registered_inactive' as const, modelId: id, isActive: false };
    });
  }
  private async load(id: string, db: Executor = this.db) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw Error('registry_model_missing');
    const row = (await sql<ModelRow>`SELECT m.id,m.stage,m.algorithm,m.is_active,m.artifact_sha256,
      a.plan_text,a.candidate_text,a.freeze_text,a.plan_sha256,a.candidate_sha256,a.freeze_sha256
      FROM prediction_model_versions m JOIN v1_model_artifacts a ON a.model_id=m.id WHERE m.id=${id}`.execute(db)).rows[0];
    if (!row) throw Error('registry_model_missing');
    const artifact = verifyV1RegistryArtifact({ planText: row.plan_text, candidateText: row.candidate_text, freezeText: row.freeze_text,
      planSha256: row.plan_sha256, candidateSha256: row.candidate_sha256, freezeSha256: row.freeze_sha256 });
    if (row.stage !== 'pre_match' || row.algorithm !== 'fixed_player_mean_elo' || row.artifact_sha256 !== artifact.bytes.candidateSha256)
      throw Error('registry_model_binding');
    return { row, artifact };
  }
  async transition(input: unknown) {
    const request = V1RegistryTransitionSchema.parse(input), requestHash = registryHash(request);
    return this.db.transaction().execute(async tx => {
      await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('model-registry:pre_match',0))`.execute(tx);
      const previous = (await sql<EventRow>`SELECT ${eventColumns} FROM model_activation_events WHERE v1_request_id=${request.requestId}`.execute(tx)).rows[0];
      if (previous) {
        if (previous.requestHash !== requestHash) throw Error('registry_request_conflict');
        return { status: 'already_recorded' as const, event: previous, activeModelId: await current(tx) };
      }
      if (await current(tx) !== request.expectedCurrentId) throw Error('registry_current_changed');
      if (request.modelId && request.release) {
        const saved = await this.load(request.modelId, tx), release = request.release;
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-release-evaluation:' + release.planFingerprint},0))`.execute(tx);
        const latest = (await sql<{ revision: number; report_sha256: string }>`SELECT revision,report_sha256 FROM v1_release_evaluation_journal
          WHERE plan_fingerprint=${release.planFingerprint} ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
        if (!latest || latest.revision !== release.revision || latest.report_sha256 !== release.reportSha256) throw Error('registry_release_not_latest');
        const report = await new V1ReleaseEvaluationJournal(this.db).read(release.planFingerprint, release.revision);
        verifyV1RegistryRelease(saved.artifact, report.artifact, await now(tx));
      } else if (request.expectedCurrentId) await this.load(request.expectedCurrentId, tx);
      const event = (await sql<EventRow>`INSERT INTO model_activation_events(stage,event_type,previous_model_id,activated_model_id,
        actor,reason,v1_request_id,v1_request_hash,v1_plan_fingerprint,v1_release_revision,v1_report_sha256)
        VALUES ('pre_match',${request.action},${request.expectedCurrentId},${request.modelId},'owner',${request.reason},
          ${request.requestId},${requestHash},${request.release?.planFingerprint ?? null},${request.release?.revision ?? null},
          ${request.release?.reportSha256 ?? null}) RETURNING ${eventColumns}`.execute(tx)).rows[0]!;
      return { status: 'recorded' as const, event, activeModelId: await current(tx) };
    });
  }
  async list() {
    const models = (await sql<{ modelId: string; version: string; isActive: boolean; planFingerprint: string;
      candidateSha256: string; freezeSha256: string; registeredAt: Date }>`SELECT m.id AS "modelId",m.version,m.is_active AS "isActive",
        a.plan_fingerprint AS "planFingerprint",a.candidate_sha256 AS "candidateSha256",a.freeze_sha256 AS "freezeSha256",a.registered_at AS "registeredAt"
        FROM v1_model_artifacts a JOIN prediction_model_versions m ON m.id=a.model_id ORDER BY a.registered_at,m.id LIMIT 1001`.execute(this.db)).rows;
    if (models.length > 1000) throw Error('registry_list_limit');
    return models.map(m => ({ ...m, registeredAt: m.registeredAt.toISOString() }));
  }
  async events() {
    const rows = (await sql<EventRow>`SELECT ${eventColumns} FROM model_activation_events WHERE v1_request_id IS NOT NULL
      ORDER BY registry_sequence LIMIT 1001`.execute(this.db)).rows;
    if (rows.length > 1000) throw Error('registry_list_limit');
    return rows;
  }
  /** Model gate only; scenario/history/target coverage and issuance still belong to S3-06. */
  async readiness() {
    return this.db.transaction().execute(async tx => {
      const gate = await this.lockForPrediction(tx);
      if (gate.status === 'unavailable') return { status: gate.status, reason: gate.reason, modelId: gate.modelId, teamAWinProbability: null };
      return { status: gate.status, modelId: gate.modelId, reportSha256: gate.reportSha256, teamAWinProbability: null };
    });
  }
  /** Caller must hold this READ COMMITTED transaction through snapshot persistence. */
  async lockForPrediction(tx: Transaction<Database>) {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('model-registry:pre_match',0))`.execute(tx);
      const id = await current(tx);
      if (!id) return { status: 'unavailable' as const, reason: 'NO_ACTIVE_MODEL', modelId: null, teamAWinProbability: null };
      try {
        const saved = await this.load(id, tx);
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-release-evaluation:' + saved.artifact.plan.fingerprint},0))`.execute(tx);
        const latest = (await sql<{ revision: number }>`SELECT revision FROM v1_release_evaluation_journal
          WHERE plan_fingerprint=${saved.artifact.plan.fingerprint} ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
        if (!latest) throw Error('registry_release_not_latest');
        const report = await new V1ReleaseEvaluationJournal(this.db).read(saved.artifact.plan.fingerprint, latest.revision);
        verifyV1RegistryRelease(saved.artifact, report.artifact, await now(tx));
        const activation = (await sql<{ id: string }>`SELECT id FROM model_activation_events WHERE stage='pre_match'
          AND activated_model_id=${id} AND v1_request_id IS NOT NULL ORDER BY registry_sequence DESC LIMIT 1`.execute(tx)).rows[0];
        if (!activation) throw Error('registry_activation_missing');
        return { status: 'model_eligible' as const, modelId: id, reportSha256: report.sha256,
          releaseRevision: latest.revision, activationEventId: activation.id, artifact: saved.artifact, teamAWinProbability: null };
      } catch {
        return { status: 'unavailable' as const, reason: 'ACTIVE_MODEL_EVIDENCE_INVALID', modelId: id, teamAWinProbability: null };
      }
  }
}
