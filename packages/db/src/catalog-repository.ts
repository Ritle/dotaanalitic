import { sql } from 'kysely';
import { CatalogIdSchema, CatalogKindSchema, CatalogQuerySchema, CatalogListSchema, PlayerOverviewSchema, TeamOverviewSchema,
  type CatalogKind, type CatalogQuery } from '@dota/contracts';
import type { Db } from './index.js';

type ItemRow = { id: string; name: string; secondary: string | null; synced_at: Date | null; updated_at: Date };
const item = (row: ItemRow) => ({ id: row.id, name: row.name, secondary: row.secondary,
  syncedAt: row.synced_at?.toISOString() ?? null, metadataUpdatedAt: row.updated_at.toISOString() });
const catalogWarnings = ['LOCAL_CATALOG_ONLY','SYNC_TIME_IS_NOT_HISTORICAL_AVAILABILITY'];

/** Catalogue metadata only. No provider totals, team rating or prediction features. */
export class CatalogRepository {
  constructor(private readonly db: Db) {}
  async search(kind: CatalogKind, input: CatalogQuery) {
    CatalogKindSchema.parse(kind);
    const query = CatalogQuerySchema.parse(input);
    // Table and column names come only from this closed mapping. Search text is a bound value.
    const table = kind === 'teams' ? 'teams' : kind === 'players' ? 'players' : 'heroes';
    const name = kind === 'teams' ? 'name' : kind === 'players' ? 'nickname' : 'localized_name';
    const secondary = kind === 'teams' ? sql`tag` : kind === 'heroes' ? sql`internal_name` : sql`NULL::text`;
    const synced = kind === 'heroes' ? sql`NULL::timestamptz` : sql`synced_at`;
    const rows = (await sql<ItemRow>`SELECT id::text,${sql.ref(name)} AS name,${secondary} AS secondary,${synced} AS synced_at,updated_at
      FROM ${sql.table(table)} WHERE ${query.query}='' OR id::text=${query.query}
      OR strpos(lower(${sql.ref(name)}),lower(${query.query}))>0
      OR strpos(lower(coalesce(${secondary},'')),lower(${query.query}))>0
      ORDER BY lower(${sql.ref(name)}),id LIMIT ${query.limit+1} OFFSET ${query.offset}`.execute(this.db)).rows;
    return CatalogListSchema.parse({ kind, items: rows.slice(0,query.limit).map(item), hasMore: rows.length>query.limit,
      filters: query, source: 'local_catalog', computedAt: new Date().toISOString(), warnings: catalogWarnings });
  }
  async team(id: string) {
    CatalogIdSchema.parse(id);
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx => {
      const cutoffAt = new Date().toISOString();
      const team = (await sql<ItemRow>`SELECT id::text,name,tag AS secondary,synced_at,updated_at FROM teams WHERE id=${id}`.execute(trx)).rows[0];
      if (!team) return null;
      const map = (await sql<{ id:string; started_at:Date; synced_at:Date; source:string; side:'radiant'|'dire' }>`
        SELECT id::text,started_at,synced_at,source,CASE WHEN radiant_team_id=${id} THEN 'radiant' ELSE 'dire' END AS side
        FROM matches WHERE (radiant_team_id=${id} OR dire_team_id=${id}) AND is_pro IS TRUE AND ingest_state<>'conflict'
        AND started_at<${cutoffAt} AND duration_seconds>0 AND radiant_win IS NOT NULL
        AND started_at+make_interval(secs=>duration_seconds)<=${cutoffAt}
        ORDER BY started_at DESC,id DESC LIMIT 1`.execute(trx)).rows[0];
      const members = map ? (await sql<{ player_slot:number; player_id:string|null; nickname:string|null }>`
        SELECT mp.player_slot,mp.player_id::text,p.nickname FROM match_players mp LEFT JOIN players p ON p.id=mp.player_id
        WHERE mp.match_id=${map.id} AND mp.side=${map.side} ORDER BY mp.player_slot`.execute(trx)).rows : [];
      const complete = members.length===5 && members.every(p=>p.player_id!==null) && new Set(members.map(p=>p.player_id)).size===5;
      return TeamOverviewSchema.parse({ entity:item(team), entityType:'organization', currentLineup:null,
        latestObservedLineup: map ? {matchId:map.id,startedAt:map.started_at.toISOString(),syncedAt:map.synced_at.toISOString(),source:map.source,
          side:map.side,status:complete?'complete':'incomplete',members:members.map(p=>({playerSlot:p.player_slot,playerId:p.player_id,name:p.nickname}))} : null,
        source:'local_catalog',cutoffAt,computedAt:new Date().toISOString(),
        warnings:[...catalogWarnings,'CURRENT_LINEUP_UNKNOWN','OBSERVED_LINEUP_IS_NOT_PREMATCH_EVIDENCE',...(complete?[]:['INCOMPLETE_OBSERVED_LINEUP'])] });
    });
  }
  async player(id: string) {
    CatalogIdSchema.parse(id);
    const row = (await sql<ItemRow & {account:string|null}>`SELECT id::text,nickname AS name,NULL::text AS secondary,
      synced_at,updated_at,opendota_account_id::text AS account FROM players WHERE id=${id}`.execute(this.db)).rows[0];
    return row ? PlayerOverviewSchema.parse({entity:item(row),entityType:'canonical_player',catalogAccountId:row.account,
      accountVerification:'not_assessed',currentTeam:null,source:'local_catalog',computedAt:new Date().toISOString(),
      warnings:[...catalogWarnings,'ACCOUNT_LINK_NOT_VERIFIED_BY_CATALOG','CURRENT_TEAM_UNKNOWN','PLAYER_HISTORY_FOLLOWS_VERIFIED_IDENTITY']}) : null;
  }
}
