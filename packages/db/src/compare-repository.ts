import {sql} from 'kysely';
import {CompareRequestSchema,type CompareRequest} from '@dota/contracts';
import type {Db} from './index.js';
import {readProMapInventory} from './pro-map-reader.js';
import {readAccountEvidence} from './identity-repository.js';
import {readStrengthHistory} from './strength-repository.js';
import {buildCompareReport} from './compare-report.js';
export class CompareQueryError extends Error{}
export class CompareRepository{
  constructor(private readonly db:Db){}
  async report(request:CompareRequest){
    request=CompareRequestSchema.parse(request);const snapshotAt=new Date().toISOString(),cutoffAt=request.cutoffAt??snapshotAt,
      fromAt=request.fromAt??new Date(Math.max(0,Date.parse(cutoffAt)-90*86400000)).toISOString(),input={...request,fromAt,cutoffAt};
    if(cutoffAt>snapshotAt||fromAt>=cutoffAt)throw new CompareQueryError('invalid_compare_window');
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
      const names=(await sql<{id:string;name:string}>`SELECT id,name FROM teams WHERE id=ANY(${[input.teamAId,input.teamBId]}::bigint[])`.execute(trx)).rows;
      if(names.length!==2)return null;
      const ids=[...input.lineupA,...input.lineupB].flatMap(p=>p.playerId??[]);
      if((await sql`SELECT id FROM players WHERE id=ANY(${ids}::bigint[])`.execute(trx)).rows.length!==ids.length)throw new CompareQueryError('unknown_compare_player');
      const inventory=await readProMapInventory(trx,sql`TRUE`,fromAt,cutoffAt,snapshotAt);
      if(!inventory)return {status:'unavailable' as const,reason:'WINDOW_TOO_LARGE' as const,maxCandidates:5000 as const,message:'В периоде больше 5000 карт. Уточните начало истории.'};
      const accounts=(await sql<{account:string}>`SELECT external_account_id AS account FROM player_account_evidence WHERE player_id=ANY(${ids}::bigint[])
        UNION SELECT external_account_id FROM player_external_accounts WHERE player_id=ANY(${ids}::bigint[])
        UNION SELECT opendota_account_id::text FROM players WHERE id=ANY(${ids}::bigint[]) AND opendota_account_id IS NOT NULL`.execute(trx)).rows.map(r=>r.account);
      const extra=await readAccountEvidence(trx,accounts),evidence=[...new Map([...inventory.evidence,...extra].map(e=>[e.observationId,e])).values()];
      return buildCompareReport(input,snapshotAt,inventory.candidates,evidence,inventory.registry,inventory.identityRevision,new Map(names.map(n=>[n.id,n.name])),
        await readStrengthHistory(trx,cutoffAt,snapshotAt));
    });
  }
}
