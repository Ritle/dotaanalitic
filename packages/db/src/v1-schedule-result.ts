import {V1ScheduleResultRequestSchema,V1ScheduleResultRecordSchema,V1ForecastOutcomeSchema} from '@dota/contracts';
import {sql,type Db,type Executor} from './index.js';
import {V1RuntimeRepository} from './v1-runtime-repository.js';
import {registryHash,registrySha} from './v1-registry.js';
type Row={record_text:string;record_sha256:string;request_hash:string};
function saved(row:Row){
  const record=V1ScheduleResultRecordSchema.parse(JSON.parse(row.record_text));
  if(registrySha(row.record_text)!==row.record_sha256||registryHash(record.request)!==row.request_hash)throw Error('schedule_result_integrity');
  return {record,sha256:row.record_sha256};
}
export class V1ScheduleResultRepository {
  constructor(private readonly db:Db){}
  async findForTarget(owner:string,targetId:string){
    V1ScheduleResultRecordSchema.shape.ownerId.parse(owner);V1ScheduleResultRequestSchema.shape.requestId.parse(targetId);
    const row=(await sql<Row>`SELECT * FROM v1_schedule_result_bindings WHERE owner_user_id=${owner}::uuid AND target_request_id=${targetId}::uuid`.execute(this.db)).rows[0];
    return row?saved(row):null;
  }
  async get(owner:string,id:string,db:Executor=this.db){
    V1ScheduleResultRecordSchema.shape.ownerId.parse(owner);V1ScheduleResultRequestSchema.shape.requestId.parse(id);
    const row=(await sql<Row>`SELECT * FROM v1_schedule_result_bindings WHERE owner_user_id=${owner}::uuid AND request_id=${id}::uuid`.execute(db)).rows[0];
    if(!row)throw Error('NOT_FOUND');return saved(row);
  }
  async bind(owner:string,input:unknown){
    V1ScheduleResultRecordSchema.shape.ownerId.parse(owner);
    const request=V1ScheduleResultRequestSchema.parse(input),requestHash=registryHash(request);
    return this.db.transaction().execute(async tx=>{
      await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-schedule-result:'+owner},0))`.execute(tx);
      const previous=(await sql<Row>`SELECT * FROM v1_schedule_result_bindings WHERE owner_user_id=${owner}::uuid AND request_id=${request.requestId}::uuid`.execute(tx)).rows[0];
      if(previous){if(previous.request_hash!==requestHash)throw Error('schedule_result_request_conflict');return saved(previous);}
      const prediction=await new V1RuntimeRepository(this.db).get(owner,request.predictionRequestId,tx),s=prediction?.snapshot;
      if(!prediction||!s)throw Error('NOT_FOUND');
      if(s.request.purpose!=='real_map'||s.request.realTarget.provider!=='pandascore')throw Error('schedule_result_target_required');
      const target=s.request.realTarget;
      if(target.targetSha256!==request.targetSha256)throw Error('schedule_result_target_mismatch');
      const reviewedAt=(await sql<{time:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`.execute(tx)).rows[0]!.time;
      const result=(await sql<{result:unknown}>`SELECT verify_v1_schedule_candidate(${prediction.id}::uuid,${request.matchId}::bigint,
        ${request.providerSeriesId},date_trunc('milliseconds',${reviewedAt}::timestamptz)) AS result`.execute(tx)).rows[0]!.result;
      const verification=V1ForecastOutcomeSchema.parse(result);
      if(verification.status!=='linked')throw Error('schedule_result_map_unverified');
      const record=V1ScheduleResultRecordSchema.parse({format:'v1-schedule-result-binding-v1',ownerId:owner,request,predictionId:prediction.id,
        target,reviewedAt,basis:'owner_reviewed_cross_provider_mapping',verification}),text=JSON.stringify(record);
      const row=(await sql<Row>`INSERT INTO v1_schedule_result_bindings(owner_user_id,request_id,request_hash,target_request_id,provider_match_id,
        prediction_id,match_id,provider_series_id,record_text,record_sha256) VALUES(${owner}::uuid,${request.requestId}::uuid,${requestHash},
        ${target.targetRequestId}::uuid,${target.providerMatchId}::bigint,${prediction.id}::uuid,${request.matchId}::bigint,
        ${request.providerSeriesId},${text},${registrySha(text)}) RETURNING *`.execute(tx)).rows[0]!;
      return saved(row);
    });
  }
}
