import {sql,type Db} from './index.js';
import {HistoryRunSchema,type HistoryRun} from '@dota/contracts';
export interface HistoryRow {id:string;owner_user_id:string;team_id:string;provider_team_id:string;status:HistoryRun['status'];
  created_at:Date;updated_at:Date;started_at:Date|null;finished_at:Date|null;next_allowed_at:Date;source_fetched_at:Date|null;
  lease_token:string|null;attempt:number;selected:number|null;processed:number;accepted:number;duplicates:number;excluded:number;
  source_errors:number;conflicts:number;error_code:HistoryRun['errorCode'];audits:unknown[];}
export const historyRun=(r:HistoryRow)=>HistoryRunSchema.parse({id:r.id,teamId:r.team_id,status:r.status,
  createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString(),startedAt:r.started_at?.toISOString()??null,
  finishedAt:r.finished_at?.toISOString()??null,sourceFetchedAt:r.source_fetched_at?.toISOString()??null,attempt:r.attempt,
  selected:r.selected,processed:r.processed,accepted:r.accepted,duplicates:r.duplicates,excluded:r.excluded,sourceErrors:r.source_errors,
  conflicts:r.conflicts,errorCode:r.error_code});
export class HistoryRefreshRepository{
  constructor(readonly db:Db){}
  async team(id:string){return (await sql<{id:string;opendota_team_id:string|null}>`SELECT id,opendota_team_id FROM teams WHERE id=${id}`.execute(this.db)).rows[0]??null;}
  async latest(owner:string,team:string){return (await sql<HistoryRow>`SELECT * FROM history_refresh_runs WHERE owner_user_id=${owner}::uuid AND team_id=${team}
    ORDER BY created_at DESC,id DESC LIMIT 1`.execute(this.db)).rows[0]??null;}
  async get(id:string){return (await sql<HistoryRow>`SELECT * FROM history_refresh_runs WHERE id=${id}::uuid`.execute(this.db)).rows[0]??null;}
  async start(id:string,token:string,attempt:number){return (await sql<HistoryRow>`UPDATE history_refresh_runs SET status='running',lease_token=${token}::uuid,
    attempt=${attempt},started_at=coalesce(started_at,clock_timestamp()),updated_at=clock_timestamp(),error_code=NULL
    WHERE id=${id}::uuid AND status IN ('queued','running') AND attempt<${attempt} RETURNING *`.execute(this.db)).rows[0]??null;}
  async audit(id:string,token:string,selected:number,excluded:number,sourceErrors:number,fetchedAt:string,audit:unknown){
    return (await sql`UPDATE history_refresh_runs SET selected=${selected},processed=0,accepted=0,duplicates=0,conflicts=0,
      excluded=${excluded},source_errors=${sourceErrors},source_fetched_at=${fetchedAt},audits=audits||${JSON.stringify([audit])}::jsonb,updated_at=clock_timestamp()
      WHERE id=${id}::uuid AND lease_token=${token}::uuid AND status='running' RETURNING id`.execute(this.db)).rows.length>0;
  }
  async progress(id:string,token:string,p:{processed:number;accepted:number;duplicates:number;conflicts:number}){
    return (await sql`UPDATE history_refresh_runs SET processed=${p.processed},accepted=${p.accepted},duplicates=${p.duplicates},conflicts=${p.conflicts},updated_at=clock_timestamp()
      WHERE id=${id}::uuid AND lease_token=${token}::uuid AND status='running' RETURNING id`.execute(this.db)).rows.length>0;
  }
  async finish(id:string,token:string,status:'completed'|'partial'|'error',code:HistoryRun['errorCode']=null,retryAfterMs=60000){
    const delay=Math.max(60000,Math.min(86400000,Number.isFinite(retryAfterMs)?retryAfterMs:60000));
    await sql`UPDATE history_refresh_runs SET status=${status},error_code=${code},finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,
      next_allowed_at=CASE WHEN ${status}='completed' THEN greatest(next_allowed_at,clock_timestamp()+interval '5 minutes')
        ELSE clock_timestamp()+${delay}*interval '1 millisecond' END
      WHERE id=${id}::uuid AND lease_token=${token}::uuid AND status='running'`.execute(this.db);
  }
  async retry(id:string,token:string){await sql`UPDATE history_refresh_runs SET status='queued',error_code='source_unavailable',updated_at=clock_timestamp(),lease_token=NULL
    WHERE id=${id}::uuid AND lease_token=${token}::uuid AND status='running'`.execute(this.db);}
  async abandoned(id:string){await sql`UPDATE history_refresh_runs SET status=CASE WHEN processed>0 THEN 'partial' ELSE 'error' END,
    error_code='worker_unavailable',finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,next_allowed_at=clock_timestamp()+interval '1 minute'
    WHERE id=${id}::uuid AND status IN ('queued','running')`.execute(this.db);}
}
