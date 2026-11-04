import {ScheduleCacheDataSchema,V1ScheduleObservationSchema,V1ScheduleTargetPreviewSchema,V1ScheduleTargetRequestSchema,V1ScheduleTargetSavedSchema,
  CatalogIdSchema,type V1ScheduleObservation,type V1ScheduleTargetRequest} from '@dota/contracts';
import {sql,type Db,type Executor} from './index.js';
import {ScenarioError} from './scenario-repository.js';
import {registryHash,registrySha} from './v1-registry.js';
const endpoint='/dota2/matches/upcoming?sort=scheduled_at,id&page=1&per_page=20';
export function scheduleTargetReasons(o:V1ScheduleObservation,now:string){
  const reasons:string[]=[];
  if(o.match.status!=='not_started')reasons.push('SCHEDULE_NOT_UPCOMING');
  if(!o.match.scheduledAt)reasons.push('SCHEDULE_START_UNKNOWN');
  else if(o.match.scheduledAt.slice(0,-1)+'000Z'<=now)reasons.push('SCHEDULE_ALREADY_STARTED');
  if(o.match.opponents.length!==2||new Set(o.match.opponents.map(t=>t.providerTeamId)).size!==2)reasons.push('SCHEDULE_OPPONENTS_INCOMPLETE');
  return reasons;
}
export function validateScheduleMapping(o:V1ScheduleObservation,r:V1ScheduleTargetRequest){
  const ids=o.match.opponents.map(t=>t.providerTeamId);
  if(ids.length!==2||!ids.includes(r.providerTeamAId)||!ids.includes(r.providerTeamBId)||r.providerMatchId!==o.match.providerMatchId)
    throw Error('schedule_target_mapping');
}
const now=async(db:Executor)=>(await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`.execute(db)).rows[0]!.at;
async function preview(db:Executor,providerMatchId:string){
  const checkedAt=await now(db);
  const rows=(await sql<{id:string;snapshot_text:string;snapshot_sha256:string;source_payload_sha256:string;fetched_at:string;recorded_at:string}>
    `SELECT id::text,snapshot_text,snapshot_sha256,source_payload_sha256,
    to_char(source_fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fetched_at,
    to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
    FROM upcoming_source_observations WHERE cache_key='schedule' AND recorded_at<=${checkedAt}::timestamptz
    ORDER BY recorded_at DESC,id DESC LIMIT 201`.execute(db)).rows;
  let omittingLaterPages=0;
  for(const row of rows.slice(0,200)){
    if(registrySha(row.snapshot_text)!==row.snapshot_sha256)throw Error('schedule_target_source_invalid');
    const snapshot=ScheduleCacheDataSchema.safeParse(JSON.parse(row.snapshot_text));
    if(!snapshot.success||snapshot.data.source.endpoint!==endpoint||snapshot.data.source.fetchedAt!==row.fetched_at||
      snapshot.data.source.payloadSha256!==row.source_payload_sha256||new Set(snapshot.data.data.map(m=>m.providerMatchId)).size!==snapshot.data.data.length)
      throw Error('schedule_target_source_invalid');
    const match=snapshot.data.data.find(m=>m.providerMatchId===providerMatchId);if(!match){omittingLaterPages++;continue;}
    const observation=V1ScheduleObservationSchema.parse({id:row.id,snapshotSha256:row.snapshot_sha256,sourcePayloadSha256:row.source_payload_sha256,
      fetchedAt:row.fetched_at,recordedAt:row.recorded_at,knownAt:null,endpoint,adapterVersion:snapshot.data.source.adapterVersion,match});
    const reasons=scheduleTargetReasons(observation,checkedAt);
    return V1ScheduleTargetPreviewSchema.parse({observation,omittingLaterPages,checkedAt,eligible:!reasons.length,reasons});
  }
  throw Error(rows.length>200?'schedule_target_history_limit':'schedule_target_not_observed');
}
type Row={record_text:string;record_sha256:string;request_hash:string};
function saved(row:Row){
  if(registrySha(row.record_text)!==row.record_sha256)throw Error('schedule_target_integrity');
  const value=V1ScheduleTargetSavedSchema.parse({record:JSON.parse(row.record_text),sha256:row.record_sha256});
  if(registryHash(value.record.request)!==row.request_hash)throw Error('schedule_target_integrity');return value;
}
export class V1ScheduleTargetRepository{
  constructor(private readonly db:Db){}
  async preview(id:string,db:Executor=this.db){return preview(db,CatalogIdSchema.parse(id));}
  async get(owner:string,id:string,db:Executor=this.db){
    const row=(await sql<Row>`SELECT * FROM v1_schedule_targets WHERE owner_user_id=${owner}::uuid AND request_id=${id}::uuid`.execute(db)).rows[0];
    if(!row)throw new ScenarioError('NOT_FOUND');return saved(row);
  }
  async history(owner:string,providerMatchId:string,beforeRevision:number|null=null){
    const rows=(await sql<Row>`SELECT * FROM v1_schedule_targets WHERE owner_user_id=${owner}::uuid AND provider_match_id=${providerMatchId}::bigint
      AND (${beforeRevision}::integer IS NULL OR revision<${beforeRevision}) ORDER BY revision DESC LIMIT 21`.execute(this.db)).rows;
    const items=rows.slice(0,20).map(saved);return {items,nextBeforeRevision:rows.length>20?items.at(-1)!.record.revision:null};
  }
  async create(owner:string,input:unknown){
    const request=V1ScheduleTargetRequestSchema.parse(input),hash=registryHash(request);
    return this.db.transaction().execute(async tx=>{
      await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-schedule-target:'+owner},0))`.execute(tx);
      if(!(await sql`SELECT 1 FROM app_users WHERE id=${owner}::uuid AND is_active`.execute(tx)).rows.length)throw new ScenarioError('NOT_FOUND');
      const previousRequest=(await sql<Row>`SELECT * FROM v1_schedule_targets WHERE owner_user_id=${owner}::uuid AND request_id=${request.requestId}::uuid`.execute(tx)).rows[0];
      if(previousRequest){if(previousRequest.request_hash!==hash)throw Error('schedule_target_request_conflict');return saved(previousRequest);}
      const previous=(await sql<Row>`SELECT * FROM v1_schedule_targets WHERE owner_user_id=${owner}::uuid AND provider_match_id=${request.providerMatchId}::bigint
        ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];const prior=previous?saved(previous):null;
      if((prior?.record.revision??0)!==request.expectedRevision)throw new ScenarioError('CONFLICT');
      // Brief SHARE lock serializes final source selection with publishers; no network within transaction.
      await sql`LOCK TABLE upcoming_source_observations IN SHARE MODE`.execute(tx);
      const current=await preview(tx,request.providerMatchId);
      if(current.observation.id!==request.observationId||current.observation.snapshotSha256!==request.observationSha256)throw Error('schedule_target_source_changed');
      if(!current.eligible)throw Error('schedule_target_not_upcoming');validateScheduleMapping(current.observation,request);
      const teams=(await sql<{id:string;name:string}>`SELECT id::text,name FROM teams WHERE id IN (${request.teamAId}::bigint,${request.teamBId}::bigint) FOR SHARE`.execute(tx)).rows;
      const league=request.leagueId?(await sql<{name:string}>`SELECT name FROM leagues WHERE id=${request.leagueId}::bigint FOR SHARE`.execute(tx)).rows[0]:null;
      if(teams.length!==2||request.leagueId&&!league)throw Error('schedule_target_catalog_missing');
      const record=V1ScheduleTargetSavedSchema.shape.record.parse({format:'v1-schedule-target-v1',provider:'pandascore',request,revision:request.expectedRevision+1,
        previousSha256:prior?.sha256??null,selectedAt:await now(tx),observation:current.observation,omittingLaterPages:current.omittingLaterPages,
        mappingBasis:'owner_reviewed',teamAName:teams.find(t=>t.id===request.teamAId)!.name,teamBName:teams.find(t=>t.id===request.teamBId)!.name,
        leagueName:league?.name??null,mapBinding:'pending',probability:null,warnings:['OWNER_MAPPING_NOT_PROVIDER_IDENTITY','PANDASCORE_ID_NOT_OPENDOTA_SERIES',
          'FIRST_MAP_INTENT_NOT_VERIFIED_RESULT','NO_FORECAST_ISSUED',...(current.omittingLaterPages?['LATER_PARTIAL_PAGES_OMIT_MATCH']:[])]});
      const text=JSON.stringify(record);
      const row=(await sql<Row>`INSERT INTO v1_schedule_targets(owner_user_id,provider_match_id,revision,request_id,request_hash,observation_id,record_text,record_sha256)
        VALUES(${owner}::uuid,${request.providerMatchId}::bigint,${record.revision},${request.requestId}::uuid,${hash},${request.observationId}::bigint,${text},${registrySha(text)}) RETURNING *`.execute(tx)).rows[0]!;
      return saved(row);
    });
  }
}
