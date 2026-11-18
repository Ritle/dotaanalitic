import {randomUUID} from 'node:crypto';
import {sql,registrySha,registryHash,ScenarioError,type Db,type Executor} from '@dota/db';
import {captureHistoryProjection,emptyHistoryProjection} from './draft-history-source.js';
import {DraftHistoryEvidenceSchema,DraftHistorySavedSchema,type DraftHistorySaved} from './draft-history-contract.js';
type Row={id:string;evidence_text:string;evidence_sha256:string;recorded_at:string};
const recorded=sql<string>`to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
async function clock(tx:Executor){return (await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`.execute(tx)).rows[0]!.at;}
function decode(row:Row){
  if(registrySha(row.evidence_text)!==row.evidence_sha256)throw Error('draft_history_integrity');
  return DraftHistorySavedSchema.parse({id:row.id,sha256:row.evidence_sha256,recordedAt:row.recorded_at,evidence:JSON.parse(row.evidence_text)});
}
export class DraftHistoryRepository{
  constructor(private readonly db:Db){}
  async get(owner:string,scenarioId:string,revision:number,tx:Executor=this.db):Promise<DraftHistorySaved|null>{
    const row=(await sql<Row>`SELECT id,evidence_text,evidence_sha256,${recorded} AS recorded_at FROM owner_draft_history_observations
      WHERE owner_user_id=${owner}::uuid AND scenario_id=${scenarioId}::uuid AND revision=${revision}`.execute(tx)).rows[0];
    return row?decode(row):null;
  }
  /** The transaction must COMMIT before a new draft decision cutoff is obtained. */
  async prepare(owner:string,scenarioId:string,revision:number):Promise<DraftHistorySaved|null>{
    for(let attempt=0;;attempt++)try{return await this.observe(owner,scenarioId,revision);}
    catch(e){if(attempt<2&&e instanceof Error&&'code' in e&&e.code==='40001')continue;throw e;}
  }
  private async observe(owner:string,scenarioId:string,revision:number){
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
      await sql`SET LOCAL statement_timeout='30s'`.execute(tx);await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
      const current=(await sql<{revision:number}>`SELECT s.revision FROM scenarios s JOIN app_users u ON u.id=s.owner_user_id
        WHERE s.id=${scenarioId}::uuid AND s.owner_user_id=${owner}::uuid AND u.is_active AND u.account_role='owner' FOR UPDATE OF s`.execute(tx)).rows[0];
      if(!current)throw new ScenarioError('NOT_FOUND');
      // A legacy capture remains legacy: never attach newly observed facts to its earlier cutoff.
      if((await sql`SELECT id FROM owner_draft_captures WHERE owner_user_id=${owner}::uuid AND scenario_id=${scenarioId}::uuid AND revision=${revision}`.execute(tx)).rows.length)return null;
      if(current.revision!==revision)throw new ScenarioError('CONFLICT');
      const prior=await this.get(owner,scenarioId,revision,tx);if(prior)return prior;
      const scenario=(await sql<{input_hash:string}>`SELECT input_hash FROM scenario_input_snapshots WHERE scenario_id=${scenarioId}::uuid AND revision=${revision}`.execute(tx)).rows[0]!;
      const readAt=await clock(tx),reasons:string[]=[];
      let history=emptyHistoryProjection();
      try{history=await captureHistoryProjection(tx,readAt);}catch(e){
        if(!(e instanceof Error)||e.message!=='DRAFT_CAPTURE_HISTORY_LIMIT')throw e;
        reasons.push('DRAFT_CAPTURE_HISTORY_LIMIT');
      }
      const outcomes=(await sql<{result:unknown}>`SELECT verify_training_outcome(map_id,${readAt}::timestamptz,'radiant') AS result
        FROM unnest(${history.maps.map(m=>m.id)}::bigint[]) AS m(map_id) ORDER BY map_id`.execute(tx)).rows.map(r=>r.result);
      const observedAt=await clock(tx);
      const verifierMigrations=(await sql<{filename:string;sha256:string}>`SELECT filename,checksum AS sha256 FROM schema_migrations
        WHERE filename IN ('012_verified_dataset_boundary.sql','018_outcome_verifier.sql') ORDER BY filename`.execute(tx)).rows;
      const selection={format:'owner-scenario-selection-v2',scenarioId,revision,scenarioHash:scenario.input_hash,actualMatchId:null};
      const evidence=DraftHistoryEvidenceSchema.parse({format:'owner-draft-history-observation-v1',selection,selectionSha256:registryHash(selection),
        readAt,observedAt,history,outcomes,verifierMigrations,basis:'local_receipt_verification',reasons,
        primaryEligible:false,scoringPerformed:false,deployable:false});
      const text=JSON.stringify(evidence),sha=registrySha(text),id=randomUUID();
      const row=(await sql<Row>`INSERT INTO owner_draft_history_observations(id,owner_user_id,scenario_id,revision,evidence_text,evidence_sha256,read_at,observed_at)
        VALUES(${id}::uuid,${owner}::uuid,${scenarioId}::uuid,${revision},${text},${sha},${readAt}::timestamptz,${observedAt}::timestamptz)
        ON CONFLICT(owner_user_id,scenario_id,revision) DO NOTHING
        RETURNING id,evidence_text,evidence_sha256,${recorded} AS recorded_at`.execute(tx)).rows[0]!;
      if(!row)throw Error('draft_history_concurrent_retry');
      return decode(row);
    });
  }
}
