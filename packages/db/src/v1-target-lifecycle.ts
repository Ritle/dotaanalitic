import {V1LifecycleRequestSchema,V1LifecycleSavedSchema,V1LifecycleTargetSchema} from '@dota/contracts';
import {sql,type Db} from './index.js';
import {ScenarioError} from './scenario-repository.js';
import {registryHash,registrySha} from './v1-registry.js';
type Row={event_text:string;event_sha256:string;request_hash:string};
export function readLifecycleRow(row:Row){
  if(registrySha(row.event_text)!==row.event_sha256)throw Error('lifecycle_integrity');
  const saved=V1LifecycleSavedSchema.parse({event:JSON.parse(row.event_text),sha256:row.event_sha256});
  if(registryHash(saved.event.request)!==row.request_hash)throw Error('lifecycle_integrity');
  return saved;
}
export class V1TargetLifecycleRepository{
  constructor(private readonly db:Db){}
  private async target(owner:string,predictionRequestId:string){
    const row=(await sql<{target:unknown}>`SELECT snapshot_text::jsonb#>'{request,realTarget}' AS target FROM v1_runtime_snapshots
      WHERE owner_user_id=${owner}::uuid AND request_id=${predictionRequestId}::uuid
      AND snapshot_text::jsonb#>>'{request,purpose}'='real_map'`.execute(this.db)).rows[0];
    if(!row)throw new ScenarioError('NOT_FOUND');
    const t=row.target as Record<string,unknown>;
    return V1LifecycleTargetSchema.parse({provider:t.provider,providerSeriesId:t.providerSeriesId,mapNumber:t.mapNumber});
  }
  async history(owner:string,predictionRequestId:string,beforeRevision=2147483647){
    owner=V1LifecycleRequestSchema.shape.requestId.parse(owner);predictionRequestId=V1LifecycleRequestSchema.shape.predictionRequestId.parse(predictionRequestId);
    if(!Number.isInteger(beforeRevision)||beforeRevision<1||beforeRevision>2147483647)throw Error('lifecycle_invalid_cursor');
    const t=await this.target(owner,predictionRequestId);
    const rows=(await sql<Row>`SELECT * FROM v1_target_lifecycle WHERE owner_user_id=${owner}::uuid
      AND provider_series_id=${t.providerSeriesId}::bigint AND map_number=${t.mapNumber} AND revision<${beforeRevision}
      ORDER BY revision DESC LIMIT 101`.execute(this.db)).rows;
    const items=rows.slice(0,100).map(readLifecycleRow);
    return {items,nextBeforeRevision:rows.length>100?items.at(-1)!.event.revision:null};
  }
  async append(owner:string,input:unknown){
    owner=V1LifecycleRequestSchema.shape.requestId.parse(owner);
    const request=V1LifecycleRequestSchema.parse(input),target=await this.target(owner,request.predictionRequestId),hash=registryHash(request);
    // Serialize with journal capture BEFORE its repeatable-read snapshot; retry sees the committed event.
    return this.db.connection().execute(async connection=>{
      const lock='v1-journal:'+owner;await sql`SELECT pg_advisory_lock(hashtextextended(${lock},0))`.execute(connection);
      try{return await connection.transaction().execute(async tx=>{
        if(!(await sql`SELECT 1 FROM app_users WHERE id=${owner}::uuid AND is_active`.execute(tx)).rows.length)throw new ScenarioError('NOT_FOUND');
        const old=(await sql<Row>`SELECT * FROM v1_target_lifecycle WHERE owner_user_id=${owner}::uuid AND request_id=${request.requestId}::uuid`.execute(tx)).rows[0];
        if(old){if(old.request_hash!==hash)throw Error('lifecycle_request_conflict');return readLifecycleRow(old);}
        const previous=(await sql<Row>`SELECT * FROM v1_target_lifecycle WHERE owner_user_id=${owner}::uuid
          AND provider_series_id=${target.providerSeriesId}::bigint AND map_number=${target.mapNumber} ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
        const prior=previous?readLifecycleRow(previous):null;
        if((prior?.event.revision??0)!==request.expectedRevision)throw new ScenarioError('CONFLICT');
        if(prior?.event.request.action===request.action||!prior&&request.action!=='cancelled')throw Error('lifecycle_invalid_transition');
        const recordedAt=(await sql<{time:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`.execute(tx)).rows[0]!.time;
        if(request.eventAt&&Date.parse(request.eventAt)>Date.parse(recordedAt))throw Error('lifecycle_future_event');
        const saved=V1LifecycleSavedSchema.parse({event:{format:'v1-target-lifecycle-v1',ownerId:owner,target,revision:request.expectedRevision+1,
          previousSha256:prior?.sha256??null,request,source:'owner_reported',recordedAt},sha256:'0'.repeat(64)});
        const text=JSON.stringify(saved.event),sha=registrySha(text);
        const row=(await sql<Row>`INSERT INTO v1_target_lifecycle(owner_user_id,provider_series_id,map_number,revision,request_id,
          request_hash,event_text,event_sha256) VALUES(${owner}::uuid,${target.providerSeriesId}::bigint,${target.mapNumber},${saved.event.revision},
          ${request.requestId}::uuid,${hash},${text},${sha}) RETURNING *`.execute(tx)).rows[0]!;
        return readLifecycleRow(row);
      });}finally{await sql`SELECT pg_advisory_unlock(hashtextextended(${lock},0))`.execute(connection);}
    });
  }
}
