import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { AccountEvidenceSchema, AliasEvidenceSchema, CanonicalPlayerIdSchema, IdentityTimeSchema,
  PlayerHistoryRequestSchema, type AccountEvidence, type AliasEvidence, type ContextAsOf,
  type PlayerHistoryRequest, type StoredAccountEvidence } from '@dota/contracts';
import type { Db, Executor } from './index.js';
import { canonicalContextJson } from './temporal.js';
import { IDENTITY_POLICY_VERSION, resolveIdentity, resolveLineup } from './identity.js';
import { MatchContextRepository } from './context-repository.js';

const fingerprint = (value: unknown) => createHash('sha256').update(canonicalContextJson(value)).digest('hex');
type EvidenceRow = {
  observation_id: string; player_id: string; provider: 'opendota' | 'stratz'; external_account_id: string;
  link_status: AccountEvidence['status']; event_at: Date | null; known_at: Date | null; fetched_at: Date;
  evidence_ref: string | null; source: string;
};

/** Legacy links have NO historical known_at; they are current descriptive evidence only. */
export async function readAccountEvidence(db: Executor, accountIds: readonly string[]): Promise<StoredAccountEvidence[]> {
  if (accountIds.length === 0) return [];
  const { rows } = await sql<EvidenceRow>`
    SELECT 'proof:'||id::text AS observation_id,player_id,provider,external_account_id,link_status,
      event_at,known_at,fetched_at,evidence_ref,source FROM player_account_evidence
      WHERE external_account_id=ANY(${accountIds}::text[])
    UNION ALL
    SELECT 'legacy:'||id::text AS observation_id,player_id,provider,external_account_id,link_status,
      NULL::timestamptz,NULL::timestamptz,observed_at AS fetched_at,evidence_ref,'legacy-current-link' AS source
      FROM player_external_accounts WHERE external_account_id=ANY(${accountIds}::text[])
      AND provider IN ('opendota','stratz')
      AND link_status IN ('verified','rejected') AND length(btrim(evidence_ref))>0
      AND (link_status<>'verified' OR verified_at IS NOT NULL)`.execute(db);
  return rows.map(row => ({ observationId: row.observation_id, ...AccountEvidenceSchema.parse({
    playerId: row.player_id, provider: row.provider, externalAccountId: row.external_account_id,
    status: row.link_status, eventAt: row.event_at?.toISOString() ?? null, knownAt: row.known_at?.toISOString() ?? null,
    fetchedAt: row.fetched_at.toISOString(), evidenceRef: row.evidence_ref, source: row.source
  }) }));
}

export class IdentityRepository {
  constructor(private readonly db: Db) {}

  async appendAccountEvidence(input: AccountEvidence) {
    const row = AccountEvidenceSchema.parse(input);
    const digest = fingerprint(row);
    return this.db.transaction().execute(async tx => {
      // Serialize both providers in the shared Steam32 namespace, including conflicts.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:${row.externalAccountId}`},0))`.execute(tx);
      await sql`INSERT INTO player_account_evidence(player_id,provider,external_account_id,link_status,
        event_at,known_at,fetched_at,evidence_ref,source,evidence_sha256)
        VALUES (${row.playerId},${row.provider},${row.externalAccountId},${row.status},${row.eventAt},${row.knownAt},
          ${row.fetchedAt},${row.evidenceRef},${row.source},${digest}) ON CONFLICT (evidence_sha256) DO NOTHING`.execute(tx);
      const id = (await sql<{ id: string }>`SELECT id FROM player_account_evidence WHERE evidence_sha256=${digest}`.execute(tx)).rows[0]!.id;
      const resolution = resolveIdentity(await readAccountEvidence(tx, [row.externalAccountId]), row.externalAccountId, null);
      return { observationId: 'proof:' + id, resolution };
    });
  }

  async appendAlias(input: AliasEvidence): Promise<string> {
    const row = AliasEvidenceSchema.parse(input);
    const digest = fingerprint(row);
    await sql`INSERT INTO player_alias_history(player_id,alias,source,observed_at,event_at,known_at,evidence_ref,evidence_sha256)
      VALUES (${row.playerId},${row.alias},${row.source},${row.fetchedAt},${row.eventAt},${row.knownAt},${row.evidenceRef},${digest})
      ON CONFLICT (evidence_sha256) DO NOTHING`.execute(this.db);
    return (await sql<{ id: string }>`SELECT id FROM player_alias_history WHERE evidence_sha256=${digest}`.execute(this.db)).rows[0]!.id;
  }

  async aliasesAsOf(playerId: string, cutoffAt: string) {
    CanonicalPlayerIdSchema.parse(playerId); IdentityTimeSchema.parse(cutoffAt);
    const { rows } = await sql<{ id: string; alias: string; source: string; evidence_ref: string; known_at: Date; observed_at: Date }>`
      SELECT id,alias,source,evidence_ref,known_at,observed_at FROM player_alias_history
      WHERE player_id=${playerId} AND evidence_sha256 IS NOT NULL AND known_at<=${cutoffAt}
      AND (event_at IS NULL OR event_at<=${cutoffAt}) ORDER BY known_at,id`.execute(this.db);
    return rows.map(row => ({ id: row.id, playerId, alias: row.alias, source: row.source, evidenceRef: row.evidence_ref,
      knownAt: row.known_at.toISOString(), fetchedAt: row.observed_at.toISOString() }));
  }

  async lineupAsOf(input: ContextAsOf) {
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx => {
      const result = await new MatchContextRepository(tx).readAsOf(input);
      if (result.context === null) return { status: 'unavailable' as const, reason: result.reason, lineup: null };
      const fact = result.context.fields.find(field => field.field === 'lineup')?.fact;
      const ids = fact?.field === 'lineup' ? (fact.value ?? []).flatMap(row => row.playerId === null ? [] : [row.playerId]) : [];
      const existing = (await sql<{ id: string }>`SELECT id FROM players WHERE id=ANY(${ids}::bigint[])`.execute(tx)).rows.map(row => row.id);
      return { status: 'resolved' as const, reason: null,
        lineup: { ...resolveLineup(result.context, existing), dataRevision: result.context.dataRevision } };
    });
  }

  /** Retrospective participation, not a pre-known lineup cohort or training feature reader. */
  async historyForPlayers(input: PlayerHistoryRequest) {
    const query = PlayerHistoryRequestSchema.parse(input);
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx => {
      const revision = (await sql<{ revision: string }>`SELECT revision FROM identity_registry_state WHERE singleton=TRUE`.execute(tx)).rows[0]!.revision;
      const candidates = (await sql<{ external_account_id: string }>`SELECT DISTINCT external_account_id FROM player_account_evidence
        WHERE player_id=ANY(${query.playerIds}::bigint[]) AND link_status='verified' AND known_at<=${query.cutoffAt}
        AND (event_at IS NULL OR event_at<=${query.cutoffAt})`.execute(tx)).rows.map(row => row.external_account_id);
      const { rows } = await sql<{ match_id: string; started_at: Date; side: 'radiant' | 'dire'; player_slot: number;
        team_id: string | null; source_account_id: string | null; data_revision: string }>`
        SELECT m.id AS match_id,m.started_at,m.data_revision,p.side,p.player_slot,
          CASE WHEN p.side='radiant' THEN m.radiant_team_id ELSE m.dire_team_id END AS team_id,p.source_account_id
        FROM matches m JOIN match_players p ON p.match_id=m.id
        WHERE m.is_pro IS TRUE AND m.ingest_state<>'conflict' AND m.started_at<${query.cutoffAt}
        AND m.duration_seconds>0 AND m.radiant_win IS NOT NULL
        AND m.started_at + m.duration_seconds * interval '1 second'<=${query.cutoffAt}
        AND EXISTS (SELECT 1 FROM match_players target WHERE target.match_id=m.id
          AND target.source_account_id::text=ANY(${candidates}::text[]))
        ORDER BY m.started_at,m.id,p.player_slot`.execute(tx);
      const accounts = [...new Set([...candidates,...rows.flatMap(row => row.source_account_id === null ? [] : [row.source_account_id])])];
      const evidence = await readAccountEvidence(tx, accounts);
      const byAccount=new Map<string,StoredAccountEvidence[]>();
      for (const row of evidence) {
        const group=byAccount.get(row.externalAccountId)??[];
        group.push(row); byAccount.set(row.externalAccountId,group);
      }
      const resolved = new Map(accounts.map(account => [account, resolveIdentity(byAccount.get(account)??[], account, query.cutoffAt)]));
      const occurrences = new Map<string,number>();
      for (const row of rows) {
        const id = row.source_account_id === null ? null : resolved.get(row.source_account_id)?.playerId;
        if (id != null) { const key=`${row.match_id}:${id}`; occurrences.set(key,(occurrences.get(key)??0)+1); }
      }
      type Side = { matchId: string; startedAt: string; side: 'radiant' | 'dire'; teamId: string | null; dataRevision: string;
        players: { playerSlot: number; playerId: string | null; sourceAccountId: string | null; observationIds: string[] }[] };
      const grouped = new Map<string, Side>();
      const warnings = new Set<string>();
      for (const row of rows) {
        const key = `${row.match_id}:${row.side}`;
        let side = grouped.get(key);
        if (!side) { side = { matchId: row.match_id, startedAt: row.started_at.toISOString(), side: row.side,
          teamId: row.team_id, dataRevision: row.data_revision, players: [] }; grouped.set(key, side); }
        const identity = row.source_account_id === null ? undefined : resolved.get(row.source_account_id);
        const duplicate = identity?.playerId != null && (occurrences.get(`${row.match_id}:${identity.playerId}`)??0)>1;
        if (duplicate) warnings.add('DUPLICATE_CANONICAL_PLAYER');
        if (identity?.status === 'conflict') warnings.add('IDENTITY_CONFLICT');
        const playerId = duplicate ? null : identity?.playerId ?? null;
        if (playerId === null) warnings.add('UNKNOWN_PLAYER_IDS');
        side.players.push({ playerSlot: row.player_slot, playerId, sourceAccountId: row.source_account_id,
          observationIds: identity?.observationIds ?? [] });
      }
      const sides = [...grouped.values()].filter(side => side.players.some(player => player.playerId !== null && query.playerIds.includes(player.playerId)))
        .map(side => {
          const ids = side.players.flatMap(player => player.playerId === null ? [] : [player.playerId]);
          if (side.players.length!==5) warnings.add('INCOMPLETE_LINEUP');
          return { ...side, complete: side.players.length === 5 && ids.length === 5 && new Set(ids).size === 5 };
        });
      const players=query.playerIds.map(playerId=>{
        const verified=[...resolved.values()].some(identity=>identity.playerId===playerId);
        if (!verified) warnings.add('UNKNOWN_IDENTITY_HISTORY');
        const maps=new Set(sides.filter(side=>side.players.some(player=>player.playerId===playerId)).map(side=>side.matchId));
        const ambiguous=[...occurrences].some(([key,count])=>count>1 && key.endsWith(':'+playerId));
        return {playerId,status:verified?'verified' as const:'unknown' as const,mapCount:verified && !ambiguous?maps.size:null};
      });
      return { ...query, cohort: 'retrospective_participation' as const, policyVersion: IDENTITY_POLICY_VERSION,
        identityRevision: revision, nRaw: new Set(sides.map(side => side.matchId)).size, sides,
        players,
        warnings: [...warnings].sort() };
    });
  }
}
