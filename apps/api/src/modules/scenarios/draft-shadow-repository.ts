import {randomUUID} from 'node:crypto';
import {sql,registrySha,ScenarioError,type Db,type Executor} from '@dota/db';
import {DraftCaptureRepository} from './draft-capture-repository.js';
import {DraftHistoryRepository} from './draft-history-repository.js';
import {ShadowResultSchema,ShadowSummarySchema} from './draft-shadow-contract.js';
import {calculateDraftShadow,loadShadowCandidate,shadowImplementationSha,type ShadowCandidate} from './draft-shadow-runtime.js';
const clock=()=>sql<string>`to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const at=(name:string)=>sql<string>`to_char(${sql.ref(name)} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
type Row={id:string;result_text:string;result_sha256:string;recorded_at:string};
function decode(row:Row){
  if(registrySha(row.result_text)!==row.result_sha256)throw Error('shadow_integrity');
  return {id:row.id,sha256:row.result_sha256,recordedAt:row.recorded_at,result:ShadowResultSchema.parse(JSON.parse(row.result_text))};
}
export class DraftShadowRepository{
  constructor(private readonly db:Db,private readonly candidate:()=>Promise<ShadowCandidate|null>=loadShadowCandidate){}
  private async capture(owner:string,scenarioId:string,revision:number,tx:Executor){
    const allowed=(await sql`SELECT s.id FROM scenarios s JOIN app_users u ON u.id=s.owner_user_id WHERE s.id=${scenarioId}::uuid
      AND s.owner_user_id=${owner}::uuid AND u.is_active AND u.account_role='owner'`.execute(tx)).rows.length;
    if(!allowed)throw new ScenarioError('NOT_FOUND');
    const c=await new DraftCaptureRepository(this.db).get(owner,scenarioId,revision,tx);if(!c)throw new ScenarioError('NOT_FOUND');return c;
  }
  private async getRun(captureId:string,tx:Executor){
    const row=(await sql<Row>`SELECT id,result_text,result_sha256,${at('recorded_at')} AS recorded_at FROM owner_draft_shadow_runs
      WHERE capture_id=${captureId}::uuid`.execute(tx)).rows[0];return row?decode(row):null;
  }
  /** First transaction commits the immutable result. No receipt is written here. */
  async persistResult(owner:string,scenarioId:string,revision:number){
    return this.db.transaction().execute(async tx=>{
      await sql`SET LOCAL statement_timeout='30s'`.execute(tx);await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
      const c=await this.capture(owner,scenarioId,revision,tx);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'draft-shadow:'+c.id},0))`.execute(tx);
      const prior=await this.getRun(c.id,tx);if(prior)return prior;
      const link=(await sql<{observation_id:string}>`SELECT observation_id FROM owner_draft_history_links WHERE capture_id=${c.id}::uuid`.execute(tx)).rows[0];
      const observation=link?await new DraftHistoryRepository(this.db).get(owner,scenarioId,revision,tx):null;
      if(link&&observation?.id!==link.observation_id)throw Error('shadow_history_link');
      const candidate=await this.candidate(),implementationSha256=await shadowImplementationSha();
      const calculatedAt=(await sql<{at:string}>`SELECT ${clock()} AS at`.execute(tx)).rows[0]!.at;
      const result=calculateDraftShadow(c,observation,candidate,calculatedAt,implementationSha256),text=JSON.stringify(result);
      if(Buffer.byteLength(text)>16*1024*1024)throw Error('shadow_result_limit');
      const row=(await sql<Row>`INSERT INTO owner_draft_shadow_runs(id,capture_id,owner_user_id,result_text,result_sha256,writer_txid)
        VALUES(${randomUUID()}::uuid,${c.id}::uuid,${owner}::uuid,${text},${registrySha(text)},txid_current()::text)
        RETURNING id,result_text,result_sha256,${at('recorded_at')} AS recorded_at`.execute(tx)).rows[0]!;
      return decode(row);
    });
  }
  /** Second transaction observes a result that is already committed, including after crash/retry. */
  async ensure(owner:string,scenarioId:string,revision:number){
    const run=await this.persistResult(owner,scenarioId,revision);
    await this.db.transaction().execute(async tx=>{
      await sql`SET LOCAL statement_timeout='30s'`.execute(tx);await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
      await this.capture(owner,scenarioId,revision,tx);
      await sql`INSERT INTO owner_draft_shadow_receipts(run_id,result_sha256,observer_txid)
        VALUES(${run.id}::uuid,${run.sha256},txid_current()::text) ON CONFLICT(run_id) DO NOTHING`.execute(tx);
    });
    return this.summary(owner,scenarioId,revision);
  }
  async summary(owner:string,scenarioId:string,revision:number){
    const c=await this.capture(owner,scenarioId,revision,this.db),run=await this.getRun(c.id,this.db);
    const receipt=run?(await sql<{observed_at:string;result_sha256:string}>`SELECT ${at('observed_committed_at')} AS observed_at,result_sha256
      FROM owner_draft_shadow_receipts WHERE run_id=${run.id}::uuid`.execute(this.db)).rows[0]:null;
    if(receipt&&receipt.result_sha256!==run?.sha256)throw Error('shadow_receipt_integrity');
    return ShadowSummarySchema.parse({captureId:c.id,status:!run?'missing':!receipt?'awaiting_receipt':run.result.status,
      recordedAt:run?.recordedAt??null,observedCommittedAt:receipt?.observed_at??null,sha256:run?.sha256??null,
      reasons:run?.result.reasons??[],primaryEligible:false,teamAWinProbability:null});
  }
}
