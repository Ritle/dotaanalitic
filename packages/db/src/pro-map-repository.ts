import {sql} from 'kysely';
import {CatalogIdSchema,ProMapQuerySchema,type ProMapQuery} from '@dota/contracts';
import type {Db} from './index.js';
import {readProMapInventory} from './pro-map-reader.js';
import {selectProMaps} from './pro-maps.js';

export class ProMapQueryError extends Error {}
export class ProMapRepository {
  constructor(private readonly db:Db){}
  async report(kind:'teams'|'players',id:string,input:ProMapQuery) {
    CatalogIdSchema.parse(id);
    const parsed=ProMapQuerySchema.parse(input),snapshotAt=new Date().toISOString();
    const query={...parsed,cutoffAt:parsed.cutoffAt??snapshotAt};
    if(query.cutoffAt>snapshotAt || query.fromAt && query.fromAt>=query.cutoffAt || kind==='players' && query.playerId ||
      kind==='teams' && query.rolePos && !query.playerId || kind==='teams' && query.opponentId===id)
      throw new ProMapQueryError('invalid_pro_map_query');
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
      const table=kind==='teams'?'teams':'players';
      if(!(await sql`SELECT id FROM ${sql.table(table)} WHERE id=${id}`.execute(trx)).rows.length)return null;
      const target=kind==='teams'?sql`(m.radiant_team_id=${id} OR m.dire_team_id=${id})`:sql`EXISTS (
        SELECT 1 FROM match_players p WHERE p.match_id=m.id AND (p.player_id=${id} OR p.source_account_id::text IN (
          SELECT external_account_id FROM player_account_evidence WHERE player_id=${id}
          UNION SELECT external_account_id FROM player_external_accounts WHERE player_id=${id}
          UNION SELECT opendota_account_id::text FROM players WHERE id=${id})))`;
      const inventory=await readProMapInventory(trx,target,query.fromAt,query.cutoffAt,snapshotAt);
      if(!inventory)return {status:'unavailable' as const,reason:'WINDOW_TOO_LARGE' as const,maxCandidates:5000 as const,message:'В окне больше 5000 карт. Уточните начальную дату.'};
      const unattributed=(await sql<{n:string}>`SELECT count(*)::text AS n FROM matches WHERE is_pro IS TRUE AND started_at<${query.cutoffAt}::timestamptz
        AND (${query.fromAt??null}::timestamptz IS NULL OR started_at>=${query.fromAt??null}::timestamptz)
        AND (radiant_team_id IS NULL OR dire_team_id IS NULL)`.execute(trx)).rows[0]!.n;
      return selectProMaps(kind,id,query,snapshotAt,inventory.candidates,inventory.registry,inventory.evidence,inventory.identityRevision,Number(unattributed));
    });
  }
}
