import { sql } from 'kysely';
import { DatasetIdSchema, DatasetManifestSchema, DatasetMapInputSchema, type DatasetManifest, type DatasetMapInput } from '@dota/contracts';
import type { Executor } from './index.js';

/** Durable boundary only: no collection, feature generation, training or prediction-outcome linking. */
export class DatasetRepository {
  constructor(private readonly db: Executor) {}
  private transaction<T>(work: (db: Executor) => Promise<T>): Promise<T> {
    return this.db.isTransaction ? work(this.db) : this.db.transaction().execute(work);
  }
  async create(input: DatasetManifest): Promise<string> {
    const r = DatasetManifestSchema.parse(input);
    const { rows } = await sql<{ id: string }>`INSERT INTO training_dataset_versions(stage,feature_schema_version,label_policy_version,
      cutoff_policy_version,patch_registry_revision,data_revision,code_revision,split_policy,source_manifest)
      VALUES (${r.stage},${r.featureSchemaVersion},${r.labelPolicyVersion},${r.cutoffPolicyVersion},${r.patchRegistryRevision},
      ${r.dataRevision},${r.codeRevision},${JSON.stringify(r.splitPolicy)}::jsonb,${JSON.stringify(r.sourceManifest)}::jsonb)
      RETURNING id`.execute(this.db);
    return rows[0]!.id;
  }
  async append(input: DatasetMapInput) {
    const r = DatasetMapInputSchema.parse(input), features = JSON.stringify(r.features);
    return this.transaction(async trx => {
      const { rows } = await sql<{ match_id: string }>`INSERT INTO training_dataset_maps(dataset_version_id,match_id,split,
        team_a_id,team_b_id,cutoff_at,input_features,input_hash,team_a_won,label_source,label_verified_at,source_evidence,
        outcome_receipt_id,match_data_revision,series_id_snapshot)
        SELECT ${r.datasetId},m.id,${r.split},${r.teamAId},${r.teamBId},${r.cutoffAt},${features}::jsonb,
          training_json_hash(${features}::jsonb),CASE WHEN m.radiant_team_id=${r.teamAId} THEN m.radiant_win ELSE NOT m.radiant_win END,
          'opendota:receipt:'||receipt.id::text,coalesce(${r.labelVerifiedAt??null}::timestamptz,date_trunc('milliseconds',clock_timestamp())),
          jsonb_build_object('receiptId',receipt.id::text,'payloadSha256',receipt.payload_sha256,
            'adapterVersion',receipt.adapter_version,'normalizerVersion',receipt.normalizer_version,
            'receiptFetchedAt',to_char(receipt.fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
          receipt.id,m.data_revision,m.series_id
        FROM matches m JOIN provider_ingest_receipts receipt ON receipt.id=${r.outcomeReceiptId}
        WHERE m.id=${r.matchId} ON CONFLICT (dataset_version_id,match_id) DO NOTHING RETURNING match_id`.execute(trx);
      if (rows.length) return { matchId: rows[0]!.match_id, duplicate: false };
      const { rows: existing } = await sql<{ same: boolean }>`SELECT (outcome_receipt_id=${r.outcomeReceiptId}
        AND split=${r.split} AND team_a_id=${r.teamAId} AND team_b_id=${r.teamBId} AND cutoff_at=${r.cutoffAt}
        AND input_features=${features}::jsonb
        AND (${r.labelVerifiedAt??null}::timestamptz IS NULL OR label_verified_at=${r.labelVerifiedAt??null}::timestamptz)) AS same FROM training_dataset_maps
        WHERE dataset_version_id=${r.datasetId} AND match_id=${r.matchId}`.execute(trx);
      if (!existing[0]?.same) throw new Error('dataset_example_conflict_or_missing_source');
      return { matchId: r.matchId, duplicate: true };
    });
  }
  async freeze(datasetId: string) {
    const id = DatasetIdSchema.parse(datasetId);
    return this.transaction(async trx => {
      const { rows } = await sql<{ status: string; fingerprint: string | null }>`SELECT status,dataset_fingerprint AS fingerprint
        FROM training_dataset_versions WHERE id=${id} FOR UPDATE`.execute(trx);
      if (rows[0]?.status === 'frozen') return { datasetId: id, fingerprint: rows[0].fingerprint!, duplicate: true };
      if (rows[0]?.status !== 'building') throw new Error('dataset_not_building');
      const result = await sql<{ fingerprint: string }>`UPDATE training_dataset_versions SET status='frozen'
        WHERE id=${id} RETURNING dataset_fingerprint AS fingerprint`.execute(trx);
      return { datasetId: id, fingerprint: result.rows[0]!.fingerprint, duplicate: false };
    });
  }
  async reject(datasetId: string) {
    const { rows } = await sql<{ id: string }>`UPDATE training_dataset_versions SET status='rejected'
      WHERE id=${DatasetIdSchema.parse(datasetId)} AND status='building' RETURNING id`.execute(this.db);
    if (!rows[0]) throw new Error('dataset_not_building');
  }
}
