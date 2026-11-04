import { V1JournalCurrentRequestSchema as V1JournalRequestSchema,V1JournalInputV3Schema,V1JournalAllInputSchema,V1JournalAllReportSchema,V1JournalObservationSchema,V1ForecastOutcomeSchema,V1ForecastJournalReportV3Schema,
  type V1JournalObservation } from '@dota/contracts';
import { sql,type Db,type Executor } from './index.js';
import { ScenarioError } from './scenario-repository.js';
import { registryHash,registrySha } from './v1-registry.js';
import { readV1RuntimeCode } from './v1-runtime-code.js';
import { forecastOutcomeFingerprint } from './v1-forecast-outcomes.js';
import { buildV1Journal } from './v1-journal.js';
import {buildV1JournalV2,lifecycleTargetKey} from './v1-journal-v2.js';
import {buildV1JournalV3} from './v1-journal-v3.js';
import {readScheduledLifecycleRow} from './v1-scheduled-lifecycle.js';
import {readLifecycleRow} from './v1-target-lifecycle.js';
const LIMIT=5000,BYTES=33554432;
type Stored={owner_user_id:string;request_hash:string;revision:number;input_text:string;input_sha256:string;report_text:string;report_sha256:string};
function saved(row:Stored) {
  if(registrySha(row.input_text)!==row.input_sha256||registrySha(row.report_text)!==row.report_sha256)throw Error('journal_integrity');
  const report=V1JournalAllReportSchema.parse(JSON.parse(row.report_text)),input=V1JournalAllInputSchema.parse(JSON.parse(row.input_text));
  if(report.format.replace('report','input')!==input.format||report.ownerId!==row.owner_user_id||report.revision!==row.revision||report.inputSha256!==row.input_sha256||
    registryHash(report.request)!==row.request_hash||report.capturedAt!==input.capturedAt||
    registryHash(input.format==='v1-journal-input-v3'?buildV1JournalV3(input,report.request.filters):input.format==='v1-journal-input-v2'?buildV1JournalV2(input,report.request.filters):buildV1Journal(input,report.request.filters))!==registryHash(report.summary))throw Error('journal_integrity');
  return {revision:row.revision,sha256:row.report_sha256,report,input};
}
const targetKey=(r:V1JournalObservation)=>r.target?lifecycleTargetKey(r.target):null;
async function capture(db:Executor,owner:string) {
  const capturedAt=(await sql<{time:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`.execute(db)).rows[0]!.time;
  const rows=(await sql<{observation:unknown}>`WITH owned AS MATERIALIZED (
      SELECT prediction_id,snapshot_sha256,snapshot_text::jsonb AS s FROM v1_runtime_snapshots WHERE owner_user_id=${owner}::uuid
      ORDER BY prediction_id LIMIT ${LIMIT+1})
    SELECT jsonb_build_object('id',prediction_id,'requestId',s#>>'{request,requestId}','snapshotSha256',snapshot_sha256,
      'purpose',s#>>'{request,purpose}','status',s->>'status','modelId',s#>>'{gate,modelId}',
      'eligibleModelAtIssuance',s#>>'{gate,status}'='model_eligible','probability',s->'teamAWinProbability',
      'createdAt',s->>'createdAt','issuedAt',s->>'issuedAt','cutoffAt',s->>'cutoffAt',
      'scenarioId',s#>>'{scenario,id}','scenarioRevision',s#>'{scenario,revision}','title',s#>>'{scenario,input,title}',
      'teamAId',s#>>'{scenario,input,teamAId}','teamBId',s#>>'{scenario,input,teamBId}','scheduledAt',s#>>'{scenario,input,scheduledAt}',
      'lineupA',(SELECT jsonb_agg(x->'playerId') FROM jsonb_array_elements(s#>'{scenario,input,lineupA}') x),
      'lineupB',(SELECT jsonb_agg(x->'playerId') FROM jsonb_array_elements(s#>'{scenario,input,lineupB}') x),
      'target',s#>'{request,realTarget}','attemptReasons',s->'reasons','latestOutcome',NULL,'binding',NULL,
      'bindingConflict',false,'verification',NULL,'sourceChangedSinceRefresh',NULL) AS observation FROM owned ORDER BY prediction_id`.execute(db)).rows;
  if(rows.length>LIMIT)throw Error('journal_inventory_limit');
  const observations=rows.map(r=>V1JournalObservationSchema.parse(r.observation)),byId=new Map(observations.map(r=>[r.id,r]));
  const latest=(await sql<{prediction_id:string;revision:number;sha256:string;content_sha256:string}>`SELECT DISTINCT ON (o.prediction_id)
    o.prediction_id,o.revision,o.result_sha256 AS sha256,o.content_sha256 FROM v1_forecast_outcome_revisions o
    JOIN v1_runtime_snapshots s ON s.prediction_id=o.prediction_id WHERE s.owner_user_id=${owner}::uuid
    ORDER BY o.prediction_id,o.revision DESC`.execute(db)).rows;
  for(const row of latest) {const r=byId.get(row.prediction_id);if(r)r.latestOutcome={revision:row.revision,sha256:row.sha256,contentSha256:row.content_sha256};}
  const bindings=(await sql<{prediction_id:string;revision:number;sha256:string;match_id:string}>`SELECT DISTINCT ON (o.prediction_id)
    o.prediction_id,o.revision,o.result_sha256 AS sha256,o.result_text::jsonb->>'matchId' AS match_id FROM v1_forecast_outcome_revisions o
    JOIN v1_runtime_snapshots s ON s.prediction_id=o.prediction_id WHERE s.owner_user_id=${owner}::uuid AND o.result_text::jsonb->>'status'='linked'
    ORDER BY o.prediction_id,o.revision`.execute(db)).rows;
  const targets=new Map<string,typeof bindings>();
  for(const b of bindings){const r=byId.get(b.prediction_id),key=r&&targetKey(r);if(key)targets.set(key,[...(targets.get(key)??[]),b]);}
  let bytes=0;
  for(const r of observations) {
    const key=targetKey(r),candidates=key?targets.get(key)??[]:[];
    const maps=new Set(candidates.map(b=>b.match_id));
    r.bindingConflict=maps.size>1;
    if(maps.size===1) {
      const b=candidates[0]!;r.binding={sourcePredictionId:b.prediction_id,revision:b.revision,sha256:b.sha256,matchId:b.match_id};
      const result=(await sql<{result:unknown}>`SELECT verify_v1_forecast_outcome(${r.id}::uuid,${b.match_id}::bigint,
        date_trunc('milliseconds',${capturedAt}::timestamptz)) AS result`.execute(db)).rows[0]!.result;
      r.verification=V1ForecastOutcomeSchema.parse(result);
      r.sourceChangedSinceRefresh=r.latestOutcome?forecastOutcomeFingerprint(r.verification)!==r.latestOutcome.contentSha256:null;
    }
    bytes+=Buffer.byteLength(JSON.stringify(r));if(bytes>BYTES-1048576)throw Error('journal_inventory_bytes_limit');
  }
  const lifecycle=(await sql<{event_text:string;event_sha256:string;request_hash:string}>
    `SELECT DISTINCT ON (provider_series_id,map_number) * FROM v1_target_lifecycle WHERE owner_user_id=${owner}::uuid
      ORDER BY provider_series_id,map_number,revision DESC`.execute(db)).rows.map(readLifecycleRow);
  const scheduledLifecycle=(await sql<{event_text:string;event_sha256:string;request_hash:string}>
    `SELECT DISTINCT ON (provider_match_id) * FROM v1_scheduled_lifecycle WHERE owner_user_id=${owner}::uuid
      ORDER BY provider_match_id,revision DESC LIMIT 5001`.execute(db)).rows.map(readScheduledLifecycleRow);
  const scheduledBindings=(await sql<{proof:unknown}>`SELECT jsonb_build_object('providerMatchId',provider_match_id::text,'matchId',match_id::text,
    'requestId',request_id,'sha256',record_sha256,'reviewedAt',record_text::jsonb->>'reviewedAt') AS proof
    FROM v1_schedule_result_bindings WHERE owner_user_id=${owner}::uuid ORDER BY provider_match_id,request_id LIMIT 5001`.execute(db)).rows.map(r=>r.proof);
  if(scheduledLifecycle.length>LIMIT||scheduledBindings.length>LIMIT)throw Error('journal_inventory_limit');
  return V1JournalInputV3Schema.parse({format:'v1-journal-input-v3',capturedAt,code:await readV1RuntimeCode(),observations,lifecycle,scheduledLifecycle,scheduledBindings});
}
export class V1JournalRepository {
  constructor(private readonly db:Db,private readonly expectedCodeHash?:string) {}
  async get(owner:string,requestId:string) {
    owner=V1JournalRequestSchema.shape.requestId.parse(owner);
    const id=V1JournalRequestSchema.shape.requestId.parse(requestId);
    const row=(await sql<Stored>`SELECT * FROM v1_journal_reports WHERE owner_user_id=${owner}::uuid AND request_id=${id}::uuid`.execute(this.db)).rows[0];
    if(!row)throw new ScenarioError('NOT_FOUND');return saved(row);
  }
  async create(owner:string,requestInput:unknown) {
    owner=V1JournalRequestSchema.shape.requestId.parse(owner);
    const request=V1JournalRequestSchema.parse(requestInput),requestHash=registryHash(request);
    // Session lock is acquired BEFORE the repeatable-read snapshot. Waiting callers see
    // the winner's committed revision/retry, while every source read stays in one snapshot.
    return this.db.connection().execute(async connection=>{
      const lock='v1-journal:'+owner;
      await sql`SELECT pg_advisory_lock(hashtextextended(${lock},0))`.execute(connection);
      try {return await connection.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
        await sql`SET LOCAL statement_timeout='30s'`.execute(tx);
        if(!(await sql`SELECT 1 FROM app_users WHERE id=${owner}::uuid AND is_active`.execute(tx)).rows.length)throw new ScenarioError('NOT_FOUND');
        const old=(await sql<Stored>`SELECT * FROM v1_journal_reports WHERE owner_user_id=${owner}::uuid AND request_id=${request.requestId}::uuid`.execute(tx)).rows[0];
        if(old){if(old.request_hash!==requestHash)throw Error('journal_request_conflict');return saved(old);}
        const previous=(await sql<{revision:number;report_sha256:string}>`SELECT revision,report_sha256 FROM v1_journal_reports
          WHERE owner_user_id=${owner}::uuid ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
        if(this.expectedCodeHash&&registryHash(await readV1RuntimeCode())!==this.expectedCodeHash)throw Error('journal_server_code_changed');
        const input=await capture(tx,owner);
        if(this.expectedCodeHash&&registryHash(input.code)!==this.expectedCodeHash)throw Error('journal_server_code_changed');
        const inputText=JSON.stringify(input),inputSha=registrySha(inputText);
        const report=V1ForecastJournalReportV3Schema.parse({format:'v1-journal-report-v3',ownerId:owner,request,
          revision:(previous?.revision??0)+1,previousSha256:previous?.report_sha256??null,inputSha256:inputSha,capturedAt:input.capturedAt,
          summary:buildV1JournalV3(input,request.filters)}),reportText=JSON.stringify(report);
        if(Buffer.byteLength(inputText)>BYTES||Buffer.byteLength(reportText)>BYTES)throw Error('journal_report_bytes_limit');
        const row=(await sql<Stored>`INSERT INTO v1_journal_reports(owner_user_id,request_id,request_hash,revision,previous_sha256,
          captured_at,input_text,input_sha256,report_text,report_sha256) VALUES(${owner}::uuid,${request.requestId}::uuid,${requestHash},
          ${report.revision},${report.previousSha256},${input.capturedAt}::timestamptz,${inputText},${inputSha},${reportText},${registrySha(reportText)}) RETURNING *`.execute(tx)).rows[0]!;
        return saved(row);
      });} finally {await sql`SELECT pg_advisory_unlock(hashtextextended(${lock},0))`.execute(connection);}
    });
  }
}
