import {sql} from 'kysely';
import {RoleSuggestionRequestSchema,RoleLanePayloadSchema,type RoleSuggestionRequest} from '@dota/contracts';
import type {Db} from './index.js';
import {readProMapInventory} from './pro-map-reader.js';
import {buildRoleSuggestions,type RoleLaneEvidence} from './role-suggestions.js';
export class RoleSuggestionQueryError extends Error{}
export class RoleSuggestionRepository{
  constructor(private readonly db:Db){}
  async suggest(input:RoleSuggestionRequest,organizationId?:string){
    if(organizationId)CatalogOrganizationId(organizationId);
    const request=RoleSuggestionRequestSchema.parse(input),snapshotAt=new Date().toISOString(),cutoffAt=request.cutoffAt??snapshotAt;
    if(cutoffAt>snapshotAt)throw new RoleSuggestionQueryError('role_cutoff_in_future');
    const fromAt=new Date(Date.parse(cutoffAt)-90*86400000).toISOString();
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      await sql`SET LOCAL statement_timeout='10s'`.execute(tx);
      const existing=(await sql<{id:string}>`SELECT id FROM players WHERE id=ANY(${request.playerIds}::bigint[])`.execute(tx)).rows;
      if(existing.length!==request.playerIds.length)throw new RoleSuggestionQueryError('role_player_not_found');
      const target=sql`EXISTS (SELECT 1 FROM match_players p WHERE p.match_id=m.id AND (p.player_id=ANY(${request.playerIds}::bigint[]) OR
        p.source_account_id::text IN (SELECT external_account_id FROM player_account_evidence WHERE player_id=ANY(${request.playerIds}::bigint[])
        UNION SELECT external_account_id FROM player_external_accounts WHERE player_id=ANY(${request.playerIds}::bigint[]))))`;
      const inventory=await readProMapInventory(tx,organizationId?sql`(${target}) AND (m.radiant_team_id=${organizationId} OR m.dire_team_id=${organizationId})`:target,fromAt,cutoffAt,snapshotAt);
      if(!inventory)throw new RoleSuggestionQueryError('role_window_too_large');
      const ids=inventory.candidates.map(m=>m.matchId),byMap=new Map(inventory.candidates.map(m=>[m.matchId,m]));
      const rows=(await sql<{id:string;canonical_match_id:string;fetched_at:Date;source_payload:unknown}>`
        SELECT id,canonical_match_id,fetched_at,source_payload FROM provider_ingest_receipts
        WHERE canonical_match_id=ANY(${ids}::bigint[]) AND provider='opendota' AND status IN ('accepted','partial')
        AND fetched_at<=${snapshotAt}::timestamptz ORDER BY id`.execute(tx)).rows;
      const lanes:RoleLaneEvidence[]=[];
      for(const r of rows){
        const raw=RoleLanePayloadSchema.safeParse(r.source_payload),m=byMap.get(r.canonical_match_id);
        if(!raw.success||!m||raw.data.match_id!==m.matchId||raw.data.start_time*1000!==Date.parse(m.startedAt)||
          raw.data.duration!==m.durationSeconds||raw.data.radiant_win!==m.radiantWin)continue;
        lanes.push({matchId:m.matchId,receiptId:r.id,fetchedAt:r.fetched_at.toISOString(),players:raw.data.players.map(p=>({
          playerSlot:p.player_slot,accountId:p.account_id,laneRole:p.lane_role??null,gpm:p.gold_per_min??null}))});
      }
      const candidates=organizationId?inventory.candidates.map(m=>({...m,players:m.players.filter(p=>p.playerSlot<128?m.radiantTeamId===organizationId:m.direTeamId===organizationId)})):inventory.candidates;
      return buildRoleSuggestions(request.playerIds,cutoffAt,snapshotAt,candidates,inventory.evidence,lanes);
    });
  }
}
const CatalogOrganizationId=(id:string)=>{if(!/^[1-9]\d{0,18}$/.test(id)||BigInt(id)>9223372036854775807n)throw new RoleSuggestionQueryError('invalid_organization');};
