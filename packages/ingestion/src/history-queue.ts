import {PgBoss} from 'pg-boss';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {sql,CompiledQuery,HistoryRefreshRepository,type Db,type HistoryRow} from '@dota/db';
import {captureCurrentHistory,validateCurrentHistoryCapture} from './opendota/current-history.js';
import {OpenDotaError,type OpenDotaClient} from './opendota/client.js';
import {IngestionService} from './importer.js';
export const HISTORY_QUEUE='opendota-team-history';
const FAILED_QUEUE='opendota-team-history-failed',RETRIES=2;
const JobInput=z.object({runId:z.uuid()}).strict();
export async function setupHistoryQueue(boss:PgBoss){
  await boss.createQueue(FAILED_QUEUE,{retryLimit:0});
  await boss.createQueue(HISTORY_QUEUE,{policy:'exclusive',retryLimit:RETRIES,retryDelay:30,retryBackoff:true,
    expireInSeconds:300,heartbeatSeconds:30,deadLetter:FAILED_QUEUE});
}
export async function createHistoryQueue(connectionString:string,schema='pgboss'){
  const boss=new PgBoss({connectionString,schema});boss.on('error',()=>console.error(JSON.stringify({event:'history_queue_error',code:'queue_unavailable'})));
  try{await boss.start();await setupHistoryQueue(boss);return boss;}
  catch(e){await boss.stop({graceful:false}).catch(()=>undefined);throw e;}
}
/** Run row and durable job are committed together; team lock also covers cooldown deduplication. */
export async function enqueueHistoryRefresh(boss:PgBoss,db:Db,owner:string,teamId:string){
  return db.transaction().execute(async tx=>{
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`history-team:${teamId}`},0))`.execute(tx);
    const team=(await sql<{id:string;opendota_team_id:string|null}>`SELECT id,opendota_team_id FROM teams WHERE id=${teamId} FOR SHARE`.execute(tx)).rows[0];
    if(!team?.opendota_team_id||BigInt(team.opendota_team_id)<=0n)return null;
    const previous=(await sql<HistoryRow&{blocked:boolean}>`SELECT *,next_allowed_at>clock_timestamp() AS blocked FROM history_refresh_runs
      WHERE team_id=${teamId} ORDER BY created_at DESC,id DESC LIMIT 1`.execute(tx)).rows[0];
    if(previous&&(previous.status==='queued'||previous.status==='running'||previous.blocked))return previous.id;
    const id=randomUUID();
    await sql`INSERT INTO history_refresh_runs(id,owner_user_id,team_id,provider_team_id,status)
      VALUES (${id}::uuid,${owner}::uuid,${teamId},${team.opendota_team_id},'queued')`.execute(tx);
    const connection={executeSql:async(text:string,values:unknown[])=>({rows:(await tx.executeQuery(CompiledQuery.raw(text,values))).rows})};
    const sent=await boss.send(HISTORY_QUEUE,{runId:id},{id,singletonKey:teamId,db:connection});
    if(!sent)throw new Error('history_job_conflict');return id;
  });
}
type Provider=Pick<OpenDotaClient,'getTeamMatches'|'getHeroes'|'getLeagues'|'getMatchSource'>;
export async function registerHistoryWorker(boss:PgBoss,db:Db,provider:(signal:AbortSignal)=>Provider){
  const repo=new HistoryRefreshRepository(db);
  return boss.work<unknown>(HISTORY_QUEUE,{batchSize:1,pollingIntervalSeconds:1,perJobResults:true},async jobs=>{
    const job=jobs[0]!,parsed=JobInput.safeParse(job.data);
    if(!parsed.success)return [{id:job.id,status:'deadletter' as const,output:{code:'invalid_job'}}];
    const id=parsed.data.runId,token=randomUUID(),row=await repo.start(id,token,job.retryCount+1);
    if(!row)return [{id:job.id,status:'completed' as const,output:{code:'already_terminal_or_missing'}}];
    console.log(JSON.stringify({event:'history_refresh_started',run_id:id,attempt:job.retryCount+1}));
    try{
      const capture=await captureCurrentHistory(provider(job.signal),[row.provider_team_id],10),validated=validateCurrentHistoryCapture(capture);
      if(job.signal.aborted)throw new Error('history_aborted');
      const eligible=validated.matches.filter(m=>m.eligible),sources=[...capture.discoveries,capture.heroes,capture.leagues,...capture.matches];
      const audit={policyVersion:'current-history-v1',attempt:job.retryCount+1,cutoffAt:capture.cutoffAt,capturedAt:capture.capturedAt,
        captureSha256:createHash('sha256').update(JSON.stringify(capture)).digest('hex'),
        sources:sources.map(o=>({endpoint:o.source.endpoint,fetchedAt:o.source.fetchedAt,knownAt:null,payloadSha256:o.source.payloadSha256})),
        eligibility:validated.matches.map(m=>({matchId:m.matchId,eligible:m.eligible,reasons:m.reasons})),errors:capture.errors,
        predictionEligibility:'not_assessed',trainingExamples:0};
      if(!await repo.audit(id,token,validated.selection.selected.length,validated.matches.length-eligible.length,capture.errors.length,capture.capturedAt,audit))
        throw new Error('stale_history_attempt');
      const importer=new IngestionService(db,{getHeroes:async()=>validated.heroes,getLeagues:async()=>validated.leagues,getMatchSource:async matchId=>{
        const m=eligible.find(m=>m.matchId===matchId);if(!m)throw new Error('outside_history_selection');return m.observation;}});
      const progress={processed:0,accepted:0,duplicates:0,conflicts:0};
      for(const m of eligible){
        if(job.signal.aborted||!await repo.progress(id,token,progress))throw new Error('stale_history_attempt');
        const result=await importer.ingest(m.matchId);progress.processed++;
        if(result.status==='accepted'||result.status==='partial')progress.accepted++;
        if(result.duplicate)progress.duplicates++;if(result.status==='conflict')progress.conflicts++;
        if(!await repo.progress(id,token,progress))throw new Error('stale_history_attempt');
      }
      const partial=capture.errors.length>0||eligible.length!==validated.selection.selected.length||progress.conflicts>0||eligible.length===0;
      await repo.finish(id,token,partial?'partial':'completed',capture.errors.length?'source_unavailable':null);
      console.log(JSON.stringify({event:'history_refresh_finished',run_id:id,status:partial?'partial':'completed',...progress}));
      return [{id:job.id,status:'completed' as const,output:{status:partial?'partial':'completed',...progress}}];
    }catch(e){
      const source=e instanceof OpenDotaError,permanent=source&&(['invalid_configuration','invalid_id','source_schema_invalid','source_invalid_json',
        'source_response_too_large','source_id_mismatch'].includes(e.code)||e.code==='source_http_error'&&e.status!==null&&e.status<500);
      const code=source?'source_unavailable' as const:'import_failed' as const;
      if(!permanent&&job.retryCount<RETRIES)await repo.retry(id,token);
      else {const current=await repo.get(id);await repo.finish(id,token,current&&current.processed>0?'partial':'error',code,source?e.retryAfterMs??60000:60000);}
      console.error(JSON.stringify({event:'history_refresh_failed',run_id:id,code}));
      return [{id:job.id,status:permanent?'deadletter' as const:'failed' as const,output:{code}}];
    }
  });
}
