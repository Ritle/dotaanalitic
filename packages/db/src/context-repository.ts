import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { ContextAsOfSchema, ContextObservationSchema, type ContextAsOf,
  type ContextObservation, type StoredContextObservation } from '@dota/contracts';
import type { Executor } from './index.js';
import { canonicalContextJson, resolveContextAsOf } from './temporal.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalContextJson(value)).digest('hex');

export class MatchContextRepository {
  constructor(private readonly db: Executor) {}

  /** Internal evidence boundary; not a public/manual verification endpoint. */
  async append(input: ContextObservation): Promise<string> {
    const row = ContextObservationSchema.parse(input);
    const digest = hash(row);
    const value = canonicalContextJson(row.fact.value);
    // Two statements allow the SELECT to see a concurrent winner after ON CONFLICT waits.
    await sql`WITH inserted AS (INSERT INTO match_field_observations(match_id,field_name,provider,value,provider_record_id,
      event_at,known_at,fetched_at,evidence_ref,adapter_version,value_sha256,review_state,
      availability_class,earliest_stage,context_sha256)
      VALUES (${row.matchId},${'context.' + row.fact.field},${row.provider},${value}::jsonb,${row.providerRecordId},
        ${row.eventAt},${row.knownAt},${row.fetchedAt},${row.evidenceRef},${row.adapterVersion},${hash(row.fact.value)},
        ${row.reviewState},${row.availability},${row.earliestStage},${digest}) ON CONFLICT DO NOTHING RETURNING id)
      UPDATE matches SET data_revision=data_revision+1 WHERE id=${row.matchId} AND EXISTS (SELECT 1 FROM inserted)`.execute(this.db);
    const { rows } = await sql<{ id: string }>`SELECT id FROM match_field_observations
      WHERE match_id=${row.matchId} AND context_sha256=${digest}`.execute(this.db);
    if (!rows[0]) throw new Error('context_observation_not_persisted');
    return rows[0].id;
  }

  async readAsOf(input: ContextAsOf) {
    const query = ContextAsOfSchema.parse(input);
    // One SQL snapshot for start bound, conflict state and observations. No outcome/stats projection.
    const { rows } = await sql<{ started_at: Date; ingest_state: string; data_revision: string; observations: StoredContextObservation[] }>`
      SELECT m.started_at,m.ingest_state,m.data_revision,coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',o.id::text,'matchId',o.match_id::text,
        'fact',jsonb_build_object('field',substring(o.field_name from 9),'value',o.value),
        'eventAt',to_char(o.event_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'knownAt',to_char(o.known_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'fetchedAt',to_char(o.fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'availability',o.availability_class,'earliestStage',o.earliest_stage,'provider',o.provider,
        'providerRecordId',o.provider_record_id,'evidenceRef',o.evidence_ref,'adapterVersion',o.adapter_version,
        'reviewState',o.review_state) ORDER BY o.id) FROM match_field_observations o
        WHERE o.match_id=m.id AND o.context_sha256 IS NOT NULL),'[]'::jsonb) AS observations
      FROM matches m WHERE m.id=${query.matchId}`.execute(this.db);
    const map = rows[0];
    if (!map) return { status: 'unavailable' as const, reason: 'MAP_NOT_FOUND' as const, context: null };
    if (map.ingest_state === 'conflict') return { status: 'unavailable' as const, reason: 'MAP_CONFLICT' as const, context: null };
    if (Date.parse(query.cutoffAt) > map.started_at.getTime())
      return { status: 'unavailable' as const, reason: 'CUTOFF_AFTER_MAP_START' as const, context: null };
    return { status: 'resolved' as const, reason: null,
      context: { ...resolveContextAsOf(map.observations, query), dataRevision: map.data_revision } };
  }
}
