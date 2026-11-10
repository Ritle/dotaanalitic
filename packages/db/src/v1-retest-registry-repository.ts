import { randomUUID } from 'node:crypto';
import { RetestRegistryMetadataSchema, type RetestRegistryEvidence, type RetestRegistryMetadata } from '@dota/contracts';
import { sql, type Db, type Executor } from './index.js';
import { canonicalContextJson } from './temporal.js';
import { checkRetestRegistryBytes, verifyRetestRegistryEvidence } from './v1-retest-registry-verifier.js';
type Row = { model_id: string; metadata: unknown; registered_at: Date; stage: string; is_active: boolean; algorithm: string;
  artifact_sha256: string; capsule_text: string; capsule_sha256: string; freeze_text: string; freeze_sha256: string;
  started_text: string; started_sha256: string; report_text: string; report_sha256: string; binding_text: string; binding_sha256: string };
const same = (a: unknown, b: unknown) => canonicalContextJson(a) === canonicalContextJson(b);
const currentTime = async (db: Executor) => (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(db)).rows[0]!.at.toISOString();
const rowEvidence = (r: Row): RetestRegistryEvidence => ({ schemaVersion: 1, format: 'v1-retest-registry-evidence-v1',
  capsule: { text: r.capsule_text, sha256: r.capsule_sha256 }, freeze: { text: r.freeze_text, sha256: r.freeze_sha256 },
  started: { text: r.started_text, sha256: r.started_sha256 }, report: { text: r.report_text, sha256: r.report_sha256 },
  binding: { text: r.binding_text, sha256: r.binding_sha256 } });

/** Versioned intake only. Activation remains denied by SQL until its separate implementation. */
export class RetestModelRegistry {
  constructor(private readonly db: Db) {}
  private async load(id: string, db: Executor = this.db) {
    const row = (await sql<Row>`SELECT a.*,m.stage,m.is_active,m.algorithm,m.artifact_sha256
      FROM v1_retest_model_artifacts a JOIN prediction_model_versions m ON m.id=a.model_id WHERE m.id=${id}::uuid`.execute(db)).rows[0];
    if (!row) throw Error('retest_registry_model_missing');
    const evidence = checkRetestRegistryBytes(rowEvidence(row)), metadata = RetestRegistryMetadataSchema.parse(row.metadata);
    if (row.stage !== metadata.stage || row.algorithm !== metadata.algorithm || row.is_active || row.artifact_sha256 !== evidence.freeze.sha256)
      throw Error('retest_registry_model_binding');
    return { row, evidence, metadata };
  }
  async register(input: unknown) {
    const evidence = checkRetestRegistryBytes(input);
    const metadata = RetestRegistryMetadataSchema.parse(await verifyRetestRegistryEvidence(evidence));
    return this.db.transaction().execute(async tx => {
      await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('model-registry:pre_match',0))`.execute(tx);
      if (metadata.firstScoringAt > await currentTime(tx)) throw Error('retest_registry_time_gate');
      const existing = (await sql<{ model_id: string }>`SELECT model_id FROM v1_retest_model_artifacts
        WHERE protocol_fingerprint=${metadata.protocolFingerprint} OR freeze_sha256=${evidence.freeze.sha256}
          OR report_sha256=${evidence.report.sha256}`.execute(tx)).rows[0];
      if (existing) {
        const saved = await this.load(existing.model_id, tx);
        if (!same(saved.evidence, evidence) || !same(saved.metadata, metadata)) throw Error('retest_registry_registration_conflict');
        return { status: 'already_registered' as const, modelId: existing.model_id, isActive: false, teamAWinProbability: null };
      }
      const id = randomUUID();
      await sql`INSERT INTO prediction_model_versions(id,stage,version,algorithm,feature_schema_version,artifact_uri,artifact_sha256,
        trained_at,training_cutoff,train_start_at,train_end_at,test_start_at,test_end_at,train_games,test_games,metrics,hyperparameters,dataset_fingerprint)
        VALUES (${id},${metadata.stage},${'v1-retest-' + metadata.freezeFingerprint},${metadata.algorithm},${metadata.featureSchemaVersion},
          ${'v1-retest-registry:' + id},${evidence.freeze.sha256},${metadata.registeredAt}::timestamptz,${metadata.testFromAt}::timestamptz,
          ${metadata.warmupFromAt}::timestamptz,${metadata.testFromAt}::timestamptz,${metadata.testFromAt}::timestamptz,${metadata.testUntil}::timestamptz,
          0,${metadata.scoredMaps},${JSON.stringify(metadata.metrics)}::jsonb,
          ${JSON.stringify({ fit: { method: 'fixed_policy_no_fitting', initialRating: 1500, k: 32, scale: 400 }, evaluationBasis: metadata.evaluationBasis })}::jsonb,
          ${metadata.datasetFingerprint})`.execute(tx);
      await sql`INSERT INTO v1_retest_model_artifacts(model_id,protocol_fingerprint,freeze_fingerprint,report_fingerprint,
        capsule_text,capsule_sha256,freeze_text,freeze_sha256,started_text,started_sha256,report_text,report_sha256,binding_text,binding_sha256,metadata)
        VALUES (${id},${metadata.protocolFingerprint},${metadata.freezeFingerprint},${metadata.reportFingerprint},
          ${evidence.capsule.text},${evidence.capsule.sha256},${evidence.freeze.text},${evidence.freeze.sha256},
          ${evidence.started.text},${evidence.started.sha256},${evidence.report.text},${evidence.report.sha256},
          ${evidence.binding.text},${evidence.binding.sha256},${JSON.stringify(metadata)}::jsonb)`.execute(tx);
      return { status: 'registered_inactive' as const, modelId: id, isActive: false, teamAWinProbability: null };
    });
  }
  async verify(id: string) {
    const saved = await this.load(id), replay = await verifyRetestRegistryEvidence(saved.evidence);
    if (!same(replay, saved.metadata)) throw Error('retest_registry_stored_metadata');
    return { status: 'verified_inactive' as const, modelId: id, metadata: saved.metadata, reportSha256: saved.evidence.report.sha256,
      isActive: false, teamAWinProbability: null };
  }
  async list() {
    const rows = (await sql<{ modelId: string; isActive: boolean; reportSha256: string; registeredAt: Date }>`SELECT
      a.model_id AS "modelId",m.is_active AS "isActive",a.report_sha256 AS "reportSha256",a.registered_at AS "registeredAt"
      FROM v1_retest_model_artifacts a JOIN prediction_model_versions m ON m.id=a.model_id ORDER BY a.registered_at,m.id LIMIT 1001`.execute(this.db)).rows;
    if (rows.length > 1000) throw Error('retest_registry_list_limit');
    return rows.map(r => ({ ...r, registeredAt: r.registeredAt.toISOString() }));
  }
}
