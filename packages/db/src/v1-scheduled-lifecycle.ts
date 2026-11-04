import {V1ScheduledLifecycleRequestSchema,V1ScheduledLifecycleSavedSchema,V1ScheduledLifecycleHistorySchema,V1ScheduledLifecycleViewSchema,V1ScheduledLifecycleCreateSchema} from '@dota/contracts';
import {sql,type Db} from './index.js';
import {V1ScheduleTargetRepository} from './v1-schedule-target.js';
import {ScenarioError} from './scenario-repository.js';
import {registryHash,registrySha} from './v1-registry.js';
type Row={event_text:string;event_sha256:string;request_hash:string};
export function readScheduledLifecycleRow(row:Row){
  if(registrySha(row.event_text)!==row.event_sha256)throw Error('scheduled_lifecycle_integrity');
  const saved=V1ScheduledLifecycleSavedSchema.parse({event:JSON.parse(row.event_text),sha256:row.event_sha256});
  if(registryHash(saved.event.request)!==row.request_hash)throw Error('scheduled_lifecycle_integrity');return saved;
}
const view=(s:ReturnType<typeof readScheduledLifecycleRow>)=>{const {ownerId:_,...event}=s.event;return V1ScheduledLifecycleViewSchema.parse({...s,event});};
export class V1ScheduledLifecycleRepository{
  constructor(private readonly db:Db){}
  async history(owner:string,targetId:string,beforeRevision=2147483647){
    if(!Number.isInteger(beforeRevision)||beforeRevision<1||beforeRevision>2147483647)throw Error('lifecycle_invalid_cursor');
    const t=await new V1ScheduleTargetRepository(this.db).get(owner,targetId),meeting=t.record.request.providerMatchId;
    const rows=(await sql<Row>`SELECT * FROM v1_scheduled_lifecycle WHERE owner_user_id=${owner}::uuid AND provider_match_id=${meeting}::bigint
      AND revision<${beforeRevision} ORDER BY revision DESC LIMIT 21`.execute(this.db)).rows;
    const items=rows.slice(0,20).map(readScheduledLifecycleRow).map(view);
    const bound=(await sql`SELECT 1 FROM v1_schedule_result_bindings WHERE owner_user_id=${owner}::uuid AND provider_match_id=${meeting}::bigint LIMIT 1`.execute(this.db)).rows.length>0;
    return V1ScheduledLifecycleHistorySchema.parse({items,nextBeforeRevision:rows.length>20?items.at(-1)!.event.revision:null,verifiedBindingExists:bound});
  }
  async append(owner:string,input:unknown){
    const request=V1ScheduledLifecycleRequestSchema.parse(input);
    // Validate ownership and route reference before recovering any previously committed nonce.
    const target=await new V1ScheduleTargetRepository(this.db).get(owner,request.targetRequestId),meeting=target.record.request.providerMatchId,hash=registryHash(request);
    return this.db.connection().execute(async connection=>{
      const lock='v1-journal:'+owner;await sql`SELECT pg_advisory_lock(hashtextextended(${lock},0))`.execute(connection);
      try{return await connection.transaction().execute(async tx=>{
        await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-schedule-result:'+owner},0))`.execute(tx);
        if(!(await sql`SELECT 1 FROM app_users WHERE id=${owner}::uuid AND is_active`.execute(tx)).rows.length)throw new ScenarioError('NOT_FOUND');
        const old=(await sql<Row>`SELECT * FROM v1_scheduled_lifecycle WHERE owner_user_id=${owner}::uuid AND request_id=${request.requestId}::uuid`.execute(tx)).rows[0];
        if(old){if(old.request_hash!==hash)throw Error('lifecycle_request_conflict');return readScheduledLifecycleRow(old);}
        const previous=(await sql<Row>`SELECT * FROM v1_scheduled_lifecycle WHERE owner_user_id=${owner}::uuid AND provider_match_id=${meeting}::bigint ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
        const prior=previous?readScheduledLifecycleRow(previous):null;
        if((prior?.event.revision??0)!==request.expectedRevision)throw new ScenarioError('CONFLICT');
        if(prior?.event.request.action===request.action||!prior&&request.action!=='cancelled')throw Error('lifecycle_invalid_transition');
        const recordedAt=(await sql<{time:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`.execute(tx)).rows[0]!.time;
        if(request.eventAt&&Date.parse(request.eventAt)>Date.parse(recordedAt))throw Error('lifecycle_future_event');
        const event=V1ScheduledLifecycleSavedSchema.shape.event.parse({format:'v1-scheduled-lifecycle-v1',ownerId:owner,
          target:{provider:'pandascore',providerMatchId:meeting,mapNumber:1},revision:request.expectedRevision+1,previousSha256:prior?.sha256??null,
          request,source:'owner_reported',recordedAt}),text=JSON.stringify(event);
        const row=(await sql<Row>`INSERT INTO v1_scheduled_lifecycle(owner_user_id,provider_match_id,revision,request_id,request_hash,event_text,event_sha256)
          VALUES(${owner}::uuid,${meeting}::bigint,${event.revision},${request.requestId}::uuid,${hash},${text},${registrySha(text)}) RETURNING *`.execute(tx)).rows[0]!;
        return readScheduledLifecycleRow(row);
      });}finally{await sql`SELECT pg_advisory_unlock(hashtextextended(${lock},0))`.execute(connection);}
    });
  }
}
export class V1ScheduledLifecycleService{
  private writing=false;private readonly repository:V1ScheduledLifecycleRepository;
  constructor(db:Db){this.repository=new V1ScheduledLifecycleRepository(db);}
  history(owner:string,targetId:string,beforeRevision?:number){return this.repository.history(owner,targetId,beforeRevision);}
  async append(owner:string,targetId:string,input:unknown){
    if(this.writing)throw Error('scheduled_lifecycle_busy');this.writing=true;
    try{const {confirmedByOwner:_,...body}=V1ScheduledLifecycleCreateSchema.parse(input);return view(await this.repository.append(owner,{...body,targetRequestId:targetId}));}
    finally{this.writing=false;}
  }
}
