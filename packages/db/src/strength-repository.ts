import {sql} from 'kysely';
import {CatalogIdSchema,StrengthQuerySchema,StrengthProofSchema,type StrengthQuery} from '@dota/contracts';
import type {Db} from './index.js';
import {readAccountEvidence} from './identity-repository.js';
import {buildStrengthReport,strengthMetadata,type StrengthCandidate} from './strength-report.js';
export class StrengthQueryError extends Error {}
export class StrengthRepository{
  constructor(private readonly db:Db){}
  async report(organizationId:string,input:StrengthQuery){
    CatalogIdSchema.parse(organizationId);input=StrengthQuerySchema.parse(input);
    const snapshotAt=new Date().toISOString(),cutoffAt=input.cutoffAt??snapshotAt,
      fromAt=input.fromAt??new Date(Math.max(0,Date.parse(cutoffAt)-90*86400000)).toISOString(),query={...input,fromAt,cutoffAt};
    if(cutoffAt>snapshotAt||fromAt>=cutoffAt)throw new StrengthQueryError('invalid_strength_window');
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
      if(!(await sql`SELECT id FROM teams WHERE id=${organizationId}`.execute(trx)).rows.length)return null;
      const rows=(await sql<{id:string;started_at:Date;start_us:string;end_us:string|null;is_pro:boolean|null;ingest_state:string;radiant_win:boolean|null;
        radiant_team_id:string|null;dire_team_id:string|null;source:string;synced_at:Date;data_revision:string}>`SELECT id,started_at,
        (extract(epoch from started_at)*1000000)::bigint::text AS start_us,
        CASE WHEN duration_seconds>0 THEN (extract(epoch from started_at+make_interval(secs=>duration_seconds))*1000000)::bigint::text ELSE NULL END AS end_us,
        is_pro,ingest_state,radiant_win,radiant_team_id,dire_team_id,source,synced_at,data_revision FROM matches
        WHERE started_at<${cutoffAt}::timestamptz ORDER BY started_at,id LIMIT 5001`.execute(trx)).rows;
      if(rows.length>5000)return {...strengthMetadata(organizationId,query,snapshotAt),status:'unavailable' as const,reason:'GLOBAL_HISTORY_TOO_LARGE' as const,
        message:'В истории больше 5000 карт. Расчёт Elo сейчас недоступен: сокращение истории исказит рейтинг соперников.'};
      const ids=rows.map(r=>r.id),players=(await sql<{match_id:string;player_slot:number;source_account_id:string|null}>`SELECT match_id,player_slot,source_account_id FROM match_players
        WHERE match_id=ANY(${ids}::bigint[]) ORDER BY match_id,player_slot`.execute(trx)).rows;
      const facts=(await sql<{match_id:string;id:string;field:string;value:unknown;eventAtUs:string|null;knownAtUs:string|null;fetchedAtUs:string;evidenceRef:string|null;reviewState:string;availability:string;earliestStage:string}>`
        SELECT match_id,id,field_name AS field,value,(extract(epoch from event_at)*1000000)::bigint::text AS "eventAtUs",
        (extract(epoch from known_at)*1000000)::bigint::text AS "knownAtUs",(extract(epoch from fetched_at)*1000000)::bigint::text AS "fetchedAtUs",
        evidence_ref AS "evidenceRef",review_state AS "reviewState",availability_class AS availability,earliest_stage AS "earliestStage"
        FROM match_field_observations WHERE match_id=ANY(${ids}::bigint[]) AND field_name IN ('pro_classification','radiant_win','context.lineup') ORDER BY id`.execute(trx)).rows;
      const byMap=new Map<string,StrengthCandidate['players']>(),proofs=new Map<string,StrengthCandidate['proofs']>();
      for(const p of players){const group=byMap.get(p.match_id)??[];group.push({playerSlot:p.player_slot,sourceAccountId:p.source_account_id});byMap.set(p.match_id,group);}
      for(const {match_id,...f} of facts){const group=proofs.get(match_id)??[];group.push(StrengthProofSchema.parse(f));proofs.set(match_id,group);}
      const evidence=await readAccountEvidence(trx,[...new Set(players.flatMap(p=>p.source_account_id??[]))]),revision=(await sql<{revision:string}>`SELECT revision FROM identity_registry_state WHERE singleton`.execute(trx)).rows[0]!.revision;
      return buildStrengthReport(organizationId,query,snapshotAt,rows.map(r=>({matchId:r.id,startedAt:r.started_at.toISOString(),startedAtUs:r.start_us,endedAtUs:r.end_us,
        isPro:r.is_pro,conflict:r.ingest_state==='conflict',radiantWin:r.radiant_win,radiantTeamId:r.radiant_team_id,direTeamId:r.dire_team_id,source:r.source,
        syncedAt:r.synced_at.toISOString(),dataRevision:r.data_revision,players:byMap.get(r.id)??[],proofs:proofs.get(r.id)??[]})),evidence,revision);
    });
  }
}
