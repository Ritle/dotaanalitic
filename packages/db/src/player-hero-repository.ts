import {sql} from 'kysely';
import {CatalogIdSchema,PlayerHeroQuerySchema,type PlayerHeroQuery} from '@dota/contracts';
import type {Db} from './index.js';
import {readProMapInventory} from './pro-map-reader.js';
import {buildPlayerHeroReport,playerHeroMetadata} from './player-hero-report.js';
import {resolvePatchAt} from './game-context.js';
export class PlayerHeroQueryError extends Error {}
export class PlayerHeroRepository{
  constructor(private readonly db:Db){}
  async report(playerId:string,input:PlayerHeroQuery){
    CatalogIdSchema.parse(playerId);input=PlayerHeroQuerySchema.parse(input);
    const snapshotAt=new Date().toISOString(),cutoffAt=input.cutoffAt??snapshotAt;
    const fromAt=input.fromAt??new Date(Math.max(0,Date.parse(cutoffAt)-90*86400000)).toISOString(),query={...input,fromAt,cutoffAt};
    if(cutoffAt>snapshotAt||fromAt>=cutoffAt)throw new PlayerHeroQueryError('invalid_player_hero_window');
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
      if(!(await sql`SELECT id FROM players WHERE id=${playerId}`.execute(trx)).rows.length)return null;
      const target=sql`EXISTS(SELECT 1 FROM match_players p WHERE p.match_id=m.id AND (p.player_id=${playerId} OR p.source_account_id::text IN (
        SELECT external_account_id FROM player_account_evidence WHERE player_id=${playerId}
        UNION SELECT external_account_id FROM player_external_accounts WHERE player_id=${playerId}
        UNION SELECT opendota_account_id::text FROM players WHERE id=${playerId})))`;
      const inventory=await readProMapInventory(trx,target,fromAt,cutoffAt,snapshotAt);
      if(!inventory)return {...playerHeroMetadata(playerId,query,snapshotAt),status:'unavailable' as const,reason:'WINDOW_TOO_LARGE' as const,
        message:'В окне больше 5000 карт. Уточните начальную дату.'};
      const heroes=(await sql<{id:string;localized_name:string}>`SELECT id::text,localized_name FROM heroes WHERE id=ANY(${[...new Set(inventory.candidates.flatMap(m=>m.players.flatMap(p=>p.heroId??[])))]}::int[])`.execute(trx)).rows;
      const heroNames=new Map(heroes.map(h=>[h.id,h.localized_name]));
      if(query.patchScope==='current'&&resolvePatchAt(inventory.registry.patches,query.cutoffAt,snapshotAt).value===null)
        return buildPlayerHeroReport(playerId,query,snapshotAt,inventory.candidates,inventory.evidence,inventory.registry,inventory.identityRevision,heroNames);
      const reference=await readProMapInventory(trx,sql`TRUE`,undefined,fromAt,snapshotAt);
      return buildPlayerHeroReport(playerId,query,snapshotAt,inventory.candidates,inventory.evidence,inventory.registry,inventory.identityRevision,heroNames,
        reference?{candidates:reference.candidates,evidence:reference.evidence}:null,'GLOBAL_REFERENCE_TOO_LARGE');
    });
  }
}
