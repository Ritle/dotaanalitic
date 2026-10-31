import { sql } from 'kysely';
import { ContextObservationSchema, IdentityTimeSchema, ReadinessRequestSchema, type ReadinessRequest } from '@dota/contracts';
import type { Db } from './index.js';
import { MatchContextRepository } from './context-repository.js';
import { GameRegistryRepository } from './game-context-repository.js';
import { assessContextReadiness } from './readiness.js';

/** Read-only inventory and explicit research cohort gate, not DatasetBuilder or inference. */
export class DataReadinessRepository {
  constructor(private readonly db: Db) {}
  async assess(input: ReadinessRequest) {
    const query = ReadinessRequestSchema.parse(input);
    if (query.snapshotAt > new Date().toISOString()) return { status: 'unavailable' as const, reason: 'SNAPSHOT_IN_FUTURE' as const, assessment: null };
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx => {
      const base = await new MatchContextRepository(trx).readObservations({ matchId: query.matchId, cutoffAt: query.cutoffAt, stage: query.stage });
      if (base.context === null) return { status: 'unavailable' as const, reason: base.reason, assessment: null };
      const { rows } = await sql<{ completed_at: Date | null }>`SELECT CASE WHEN duration_seconds>0 AND radiant_win IS NOT NULL
        AND started_at+make_interval(secs=>duration_seconds)<=${query.snapshotAt}::timestamptz
        THEN started_at+make_interval(secs=>duration_seconds) ELSE NULL END AS completed_at FROM matches WHERE id=${query.matchId}`.execute(trx);
      const observations = base.context.observations.map(({ id, recordedAt = null, ...row }) => ({ id,
        recordedAt: recordedAt === null ? null : IdentityTimeSchema.parse(recordedAt), ...ContextObservationSchema.parse(row) }));
      const claimedIds = observations.flatMap(row => row.fact.field === 'lineup' ? (row.fact.value ?? []).flatMap(member => member.playerId ?? []) : []);
      const existing = (await sql<{ id: string }>`SELECT id FROM players WHERE id=ANY(${claimedIds}::bigint[])`.execute(trx)).rows.map(row=>row.id);
      const registry = await new GameRegistryRepository(trx).snapshot();
      return { status: 'assessed' as const, reason: null, assessment: {
        ...assessContextReadiness(observations, registry, existing, base.context.startedAt, rows[0]!.completed_at?.toISOString() ?? null, query),
        dataRevision: base.context.dataRevision } };
    });
  }
}
