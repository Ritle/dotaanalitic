import {sql} from 'kysely';
import {CatalogIdSchema,RosterRequestSchema,type RosterRequest} from '@dota/contracts';
import type {Db} from './index.js';
import {readProMapInventory} from './pro-map-reader.js';
import {readAccountEvidence} from './identity-repository.js';
import {buildRosterReport} from './roster-report.js';
export class RosterQueryError extends Error {}
export class RosterRepository{
  constructor(private readonly db:Db){}
  async report(organizationId:string,input:RosterRequest){
    CatalogIdSchema.parse(organizationId);input=RosterRequestSchema.parse(input);
    const snapshotAt=new Date().toISOString(),cutoffAt=input.cutoffAt??snapshotAt;
    if(cutoffAt>snapshotAt||input.fromAt&&input.fromAt>=cutoffAt)throw new RosterQueryError('invalid_roster_window');
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
      if(!(await sql`SELECT id FROM teams WHERE id=${organizationId}`.execute(trx)).rows.length)return null;
      const selected=[...new Set([...input.lineup,...input.expectedLineup??[]].flatMap(p=>p.playerId??[]))];
      const existing=(await sql<{id:string}>`SELECT id FROM players WHERE id=ANY(${selected}::bigint[])`.execute(trx)).rows;
      if(existing.length!==selected.length)throw new RosterQueryError('unknown_roster_player');
      // Discovery only: candidate accounts include disputed/rejected mappings; attribution is re-resolved below.
      const accounts=(await sql<{account:string}>`SELECT external_account_id AS account FROM player_account_evidence WHERE player_id=ANY(${selected}::bigint[])
        UNION SELECT external_account_id FROM player_external_accounts WHERE player_id=ANY(${selected}::bigint[])
        UNION SELECT opendota_account_id::text FROM players WHERE id=ANY(${selected}::bigint[]) AND opendota_account_id IS NOT NULL`.execute(trx)).rows.map(r=>r.account);
      const target=sql`(m.radiant_team_id=${organizationId} OR m.dire_team_id=${organizationId} OR EXISTS(
        SELECT 1 FROM match_players p WHERE p.match_id=m.id AND (p.source_account_id::text=ANY(${accounts}::text[]) OR p.player_id=ANY(${selected}::bigint[]))))`;
      const inventory=await readProMapInventory(trx,target,input.fromAt,cutoffAt,snapshotAt);
      if(!inventory)return {status:'unavailable' as const,reason:'WINDOW_TOO_LARGE' as const,maxCandidates:5000 as const,message:'В окне больше 5000 карт. Уточните начальную дату.'};
      // A verified newcomer with no maps is zero observations; an unverified identity remains unknown.
      const selectedEvidence=await readAccountEvidence(trx,accounts);
      const evidence=[...new Map([...inventory.evidence,...selectedEvidence].map(e=>[e.observationId,e])).values()];
      return buildRosterReport(organizationId,input,cutoffAt,snapshotAt,inventory.candidates,evidence,inventory.registry,inventory.identityRevision);
    });
  }
}
