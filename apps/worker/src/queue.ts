import { PgBoss, type Job } from 'pg-boss';
import { CompiledQuery, type Db } from '@dota/db';
import { OpenDotaError, ProviderIdSchema, setupHistoryQueue, type ImportResult } from '@dota/ingestion';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

export const IMPORT_QUEUE='opendota-map-import';
export const FAILED_QUEUE='opendota-map-import-failed';
export const ImportJobSchema=z.object({matchId:ProviderIdSchema,deferrals:z.number().int().min(0).max(3).optional()}).strict();
export type ImportJob=z.infer<typeof ImportJobSchema>;

export async function createQueue(connectionString:string,schema='pgboss',retryDelay=30) {
  const boss=new PgBoss({connectionString,schema});
  boss.on('error',()=>console.error(JSON.stringify({event:'queue_error',code:'queue_unavailable'})));
  try{
    await boss.start();
    await setupHistoryQueue(boss);
    await boss.createQueue(FAILED_QUEUE,{retryLimit:0});
    await boss.createQueue(IMPORT_QUEUE,{policy:'exclusive',retryLimit:3,retryDelay,retryBackoff:true,
      expireInSeconds:300,heartbeatSeconds:30,deadLetter:FAILED_QUEUE});
    return boss;
  }catch(error){await boss.stop({graceful:false}).catch(()=>undefined);throw error;}
}
export async function enqueue(boss:PgBoss,data:ImportJob) {
  const validated=ImportJobSchema.parse(data);
  return boss.send(IMPORT_QUEUE,validated,{singletonKey:validated.matchId});
}

export async function deferJob(boss:PgBoss,db:Db,job:Job<unknown>,data:ImportJob,delayMs:number) {
  return db.transaction().execute(async tx=>{
    const nextId=randomUUID();
    const connection={executeSql:async(text:string,values:unknown[]=[])=>({rows:(await tx.executeQuery(CompiledQuery.raw(text,values))).rows})};
    await boss.complete(IMPORT_QUEUE,job,{status:'deferred',nextJobId:nextId,retryAfterMs:delayMs},{db:connection});
    const next=await boss.send(IMPORT_QUEUE,{matchId:data.matchId,deferrals:(data.deferrals??0)+1},
      {id:nextId,singletonKey:data.matchId,startAfter:new Date(Date.now()+delayMs),db:connection});
    if(!next)throw new Error('deferred_job_conflict');
    return next;
  });
}

export async function registerWorker(boss:PgBoss,db:Db,ingest:(id:string,signal:AbortSignal)=>Promise<ImportResult>) {
  return boss.work<unknown>(IMPORT_QUEUE,{batchSize:1,pollingIntervalSeconds:1,perJobResults:true},async jobs=>{
    const job=jobs[0]!;
    const parsed=ImportJobSchema.safeParse(job.data);
    if(!parsed.success)return [{id:job.id,status:'deadletter' as const,output:{code:'invalid_job'}}];
    const data=parsed.data;
    console.log(JSON.stringify({event:'import_started',job_id:job.id,match_id:data.matchId,attempt:job.retryCount+1,source_provider:'opendota'}));
    try {
      const result=await ingest(data.matchId,job.signal);
      console.log(JSON.stringify({event:'import_finished',job_id:job.id,...result}));
      return [{id:job.id,status:'completed' as const,output:result}];
    }catch(error){
      const code=error instanceof OpenDotaError?error.code:'ingest_failed';
      if(error instanceof OpenDotaError && error.retryAfterMs && (data.deferrals??0)<3 &&
        (error.code==='source_rate_limited'||error.code==='request_budget_exhausted')) {
        const next=await deferJob(boss,db,job,data,error.retryAfterMs);
        console.log(JSON.stringify({event:'import_deferred',job_id:job.id,match_id:data.matchId,next_job_id:next,retry_after_ms:error.retryAfterMs}));
        return [{id:job.id,status:'completed' as const,output:{status:'deferred',nextJobId:next,retryAfterMs:error.retryAfterMs}}];
      }
      const permanent=error instanceof OpenDotaError && (['invalid_id','source_schema_invalid','source_invalid_json','source_id_mismatch','source_response_too_large'].includes(error.code)
        || error.code==='source_http_error'&&error.status!==null&&error.status>=400&&error.status<500);
      console.error(JSON.stringify({event:'import_failed',job_id:job.id,match_id:data.matchId,code}));
      return [{id:job.id,status:permanent?'deadletter' as const:'failed' as const,output:{code}}];
    }
  });
}
