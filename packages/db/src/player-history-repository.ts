import {createHash} from 'node:crypto';
import {sql,type Db} from './index.js';
import {RoleProfileRepository} from './role-profile-repository.js';
import {PlayerHistoryBindingSchema,PlayerHistoryRunSchema,PlayerHistoryReportSchema,SelectedPlayerHistoryRequestSchema,PlayerHistoryOptionsSchema,type PlayerHistoryOptions,type PlayerHistoryBinding,type PlayerHistoryRun} from '@dota/contracts';
export interface PlayerHistoryRow{id:string;owner_user_id:string;lineup_key:string;bindings:PlayerHistoryBinding[];options:PlayerHistoryOptions;operation:'import'|'evidence_resume';parent_run_id:string|null;scope_map_ids:string[];status:PlayerHistoryRun['status'];created_at:Date;finished_at:Date|null;next_allowed_at:Date;attempt:number;lease_token:string|null;report:unknown;source_audit:unknown;error_code:PlayerHistoryRun['errorCode']}
export const playerHistoryRun=(r:PlayerHistoryRow)=>PlayerHistoryRunSchema.parse({id:r.id,status:r.status,operation:r.operation,parentRunId:r.parent_run_id,createdAt:r.created_at.toISOString(),finishedAt:r.finished_at?.toISOString()??null,report:r.report,errorCode:r.error_code});
export const playerHistoryKey=(bindings:readonly PlayerHistoryBinding[],inputOptions:PlayerHistoryOptions={windowDays:90,maxMaps:10})=>{
 const options=PlayerHistoryOptionsSchema.parse(inputOptions),sorted=[...bindings].sort((a,b)=>a.playerId.localeCompare(b.playerId));
 return createHash('sha256').update(JSON.stringify(options.windowDays===90&&options.maxMaps===10?sorted:{bindings:sorted,options})).digest('hex');
};
export class PlayerHistoryRepository{
 constructor(readonly db:Db){}
 async bindings(ids:readonly string[]){
  SelectedPlayerHistoryRequestSchema.parse({playerIds:ids});const identities=await new RoleProfileRepository(this.db).identities(ids);
  if(identities.some(p=>p.identityStatus!=='verified'||p.accountIds.length!==1))return null;
  const bindings=identities.map(p=>PlayerHistoryBindingSchema.parse({playerId:p.playerId,accountId:p.accountIds[0]}));
  return new Set(bindings.map(p=>p.accountId)).size===5?bindings.sort((a,b)=>a.playerId.localeCompare(b.playerId)):null;
 }
 async latest(owner:string,key:string){return (await sql<PlayerHistoryRow>`SELECT * FROM player_history_runs WHERE owner_user_id=${owner}::uuid AND lineup_key=${key} ORDER BY created_at DESC,id DESC LIMIT 1`.execute(this.db)).rows[0]??null;}
 async get(id:string){return (await sql<PlayerHistoryRow>`SELECT * FROM player_history_runs WHERE id=${id}::uuid`.execute(this.db)).rows[0]??null;}
 async start(id:string,token:string,attempt:number){return (await sql<PlayerHistoryRow>`UPDATE player_history_runs SET status='running',lease_token=${token}::uuid,attempt=${attempt}
  WHERE id=${id}::uuid AND status IN ('queued','running') AND attempt<${attempt} RETURNING *`.execute(this.db)).rows[0]??null;}
 async active(id:string,token:string){return (await sql`SELECT id FROM player_history_runs WHERE id=${id}::uuid AND lease_token=${token}::uuid AND status='running'`.execute(this.db)).rows.length===1;}
 async finish(id:string,token:string,status:'completed'|'partial'|'error',report:unknown,audit:unknown,code:PlayerHistoryRun['errorCode']=null,retryMs=60000){
  if(report!==null)PlayerHistoryReportSchema.parse(report);
  const cooldown=status==='completed'?900000:Math.max(60000,Math.min(86400000,retryMs));
  await sql`UPDATE player_history_runs SET status=${status},report=${JSON.stringify(report)}::jsonb,source_audit=${JSON.stringify(audit)}::jsonb,error_code=${code},
   finished_at=clock_timestamp(),next_allowed_at=clock_timestamp()+${cooldown}*interval '1 millisecond',lease_token=NULL
   WHERE id=${id}::uuid AND lease_token=${token}::uuid AND status='running'`.execute(this.db);
 }
 async abandoned(id:string){await sql`UPDATE player_history_runs SET status='error',error_code='worker_unavailable',finished_at=clock_timestamp(),
  lease_token=NULL,next_allowed_at=clock_timestamp()+interval '1 minute' WHERE id=${id}::uuid AND status IN ('queued','running')`.execute(this.db);}
}
