import { sql } from 'kysely';
import { V1DataRequestSchema, V1InventoryWindowSchema, ResearchEloMapSchema, type V1DataSource, type ResearchEloMap,
  type V1ReleaseInventory } from '@dota/contracts';
import type { Db } from './index.js';
import { OutcomeVerifier } from './outcome-verifier.js';
import { readAccountEvidence } from './identity-repository.js';
import { prepareV1Data } from './v1-data.js';
import { freezeV1ReleaseInventory } from './v1-release-inventory.js';

/** SELECT-only export. Existing OutcomeVerifier takes FOR SHARE locks; no dataset/model writes. */
export class V1DataRepository {
  constructor(private readonly db: Db, private readonly syntheticOnly = false) {}
  async export(input: unknown, code: V1DataSource['code']) {
    const result = await this.read(input, code, false);
    return prepareV1Data(result.source);
  }
  async exportReleaseInventory(input: unknown, code: V1DataSource['code']) {
    const window = V1InventoryWindowSchema.parse(input);
    const result = await this.read({ ...window, schemaVersion: 1, profile: 'pre-match-player-elo-data-v1', purpose: 'development_only' }, code, true);
    return freezeV1ReleaseInventory({ schemaVersion: 1, format: 'v1-release-inventory-v1',
      source: { ...result.source, request: window }, metadata: result.metadata,
      inventoryScope: 'all_local_maps_remote_completeness_unknown' });
  }
  private async read(input: unknown, code: V1DataSource['code'], includeMetadata: boolean) {
    const request = V1DataRequestSchema.parse(input);
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx => {
      await sql`SET LOCAL statement_timeout='30s'`.execute(tx);
      const clock = (await sql<{ future: boolean }>`SELECT ${request.snapshotAt}::timestamptz > clock_timestamp() AS future`.execute(tx)).rows[0]!;
      if (clock.future) throw new Error('v1_snapshot_in_future');
      const raw = (await sql<Omit<ResearchEloMap, 'players' | 'receiptPlayers' | 'outcome' | 'seriesSourceMatched' | 'facts'>>`
        SELECT id::text AS "matchId",(extract(epoch from started_at)*1000000)::bigint::text AS "startedAtUs",
        CASE WHEN duration_seconds>0 THEN (extract(epoch from started_at+make_interval(secs=>duration_seconds))*1000000)::bigint::text END AS "endedAtUs",
        (extract(epoch from synced_at)*1000000)::bigint::text AS "syncedAtUs",data_revision::text AS "dataRevision",
        is_pro AS "isPro",ingest_state AS "ingestState",radiant_win AS "radiantWin",radiant_team_id::text AS "radiantTeamId",
        dire_team_id::text AS "direTeamId",series_id AS "seriesId" FROM matches ORDER BY started_at,id LIMIT ${request.maxMaps + 1}`.execute(tx)).rows;
      const aliases = (await sql<V1DataSource['aliases'][number]>`SELECT id AS "seriesId",provider,
        provider_series_id AS "providerSeriesId",team_a_id::text AS "teamAId",team_b_id::text AS "teamBId"
        FROM series ORDER BY id LIMIT ${request.maxMaps + 1}`.execute(tx)).rows;
      if (raw.length > request.maxMaps || aliases.length > request.maxMaps) throw new Error('v1_inventory_limit');
      const ids = raw.map(row => row.matchId);
      const players = (await sql<ResearchEloMap['players'][number] & { matchId: string }>`SELECT match_id::text AS "matchId",
        player_slot AS "playerSlot",source_account_id::text AS "sourceAccountId" FROM match_players
        WHERE match_id=ANY(${ids}::bigint[]) ORDER BY match_id,player_slot`.execute(tx)).rows;
      const facts = (await sql<ResearchEloMap['facts'][number] & { matchId: string }>`SELECT match_id::text AS "matchId",id::text,
        field_name AS field,(extract(epoch from event_at)*1000000)::bigint::text AS "eventAtUs",
        (extract(epoch from known_at)*1000000)::bigint::text AS "knownAtUs",
        (extract(epoch from fetched_at)*1000000)::bigint::text AS "fetchedAtUs",
        (extract(epoch from recorded_at)*1000000)::bigint::text AS "recordedAtUs",
        review_state AS "reviewState",availability_class AS availability FROM match_field_observations
        WHERE match_id=ANY(${ids}::bigint[]) AND fetched_at<=${request.snapshotAt}::timestamptz ORDER BY id LIMIT 20001`.execute(tx)).rows;
      if (facts.length > 20000) throw new Error('v1_fact_inventory_limit');
      const identities = (await readAccountEvidence(tx, [...new Set(players.flatMap(row => row.sourceAccountId ?? []))]))
        .filter(row => row.fetchedAt <= request.snapshotAt);
      const identityRevision = (await sql<{ revision: string }>`SELECT revision::text FROM identity_registry_state WHERE singleton`.execute(tx)).rows[0]!.revision;
      const byMap = new Map<string, ResearchEloMap['players']>(), byFact = new Map<string, ResearchEloMap['facts']>();
      for (const { matchId, ...player } of players) { const rows = byMap.get(matchId) ?? []; rows.push(player); byMap.set(matchId, rows); }
      for (const { matchId, ...fact } of facts) { const rows = byFact.get(matchId) ?? []; rows.push(fact); byFact.set(matchId, rows); }
      const candidates: ResearchEloMap[] = [];
      for (const row of raw) {
        const outcome = await new OutcomeVerifier(tx).verifyProMap({ matchId: row.matchId, snapshotAt: request.snapshotAt, teamASide: 'radiant' });
        let receiptPlayers: ResearchEloMap['receiptPlayers'] = [], seriesSourceMatched = false;
        if (outcome.status === 'verified') {
          receiptPlayers = (await sql<ResearchEloMap['receiptPlayers'][number]>`SELECT (p->>'player_slot')::integer AS "playerSlot",
            CASE WHEN p->>'account_id' ~ '^[1-9][0-9]*$' THEN p->>'account_id' ELSE NULL END AS "sourceAccountId"
            FROM provider_ingest_receipts r CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(r.source_payload->'players')='array' THEN r.source_payload->'players' ELSE '[]'::jsonb END) p
            WHERE r.id=${outcome.outcomeReceiptId}::bigint ORDER BY (p->>'player_slot')::integer`.execute(tx)).rows;
          seriesSourceMatched = (await sql`SELECT s.id FROM matches m JOIN series s ON s.id=m.series_id
            JOIN provider_ingest_receipts r ON r.id=${outcome.outcomeReceiptId}::bigint
            WHERE m.id=${row.matchId}::bigint AND s.provider='opendota' AND s.provider_series_id ~ '^[1-9][0-9]*$'
              AND r.source_payload->>'series_id'=s.provider_series_id
              AND ((s.team_a_id=m.radiant_team_id AND s.team_b_id=m.dire_team_id)
                OR (s.team_a_id=m.dire_team_id AND s.team_b_id=m.radiant_team_id))`.execute(tx)).rows.length === 1;
        }
        candidates.push(ResearchEloMapSchema.parse({ ...row, players: byMap.get(row.matchId) ?? [], receiptPlayers,
          outcome, seriesSourceMatched, facts: byFact.get(row.matchId) ?? [] }));
      }
      const metadata = includeMetadata ? (await sql<V1ReleaseInventory['metadata'][number]>`
        SELECT m.id::text AS "matchId",l.opendota_league_id::text AS "leagueId",
          a.opendota_team_id::text AS "radiantProviderTeamId",b.opendota_team_id::text AS "direProviderTeamId"
        FROM matches m LEFT JOIN leagues l ON l.id=m.league_id
        LEFT JOIN teams a ON a.id=m.radiant_team_id LEFT JOIN teams b ON b.id=m.dire_team_id
        ORDER BY m.started_at,m.id LIMIT ${request.maxMaps + 1}`.execute(tx)).rows : [];
      return { source: { request, identityRevision, candidates, aliases, identities, code,
        syntheticOnly: this.syntheticOnly }, metadata };
    });
  }
}
