import { V1OutcomeRefreshSchema, V1ForecastOutcomeSchema, type V1ForecastOutcome } from '@dota/contracts';
import { sql, type Db, type Executor } from './index.js';
import { V1RuntimeRepository } from './v1-runtime-repository.js';
import { ScenarioError } from './scenario-repository.js';
import { registryHash, registrySha } from './v1-registry.js';

export function forecastOutcomeFingerprint(result: V1ForecastOutcome) {
  const { checkedAt: _, outcome, ...rest } = result;
  const stable = outcome ? (({ labelVerifiedAt: _, ...value }) => value)(outcome) : null;
  return registryHash({ ...rest, outcome: stable });
}
type Row = { prediction_id: string; revision: number; previous_sha256: string | null; result_text: string;
  result_sha256: string; content_sha256: string };
function saved(row: Row) {
  const result = V1ForecastOutcomeSchema.parse(JSON.parse(row.result_text));
  if (registrySha(row.result_text)!==row.result_sha256 || forecastOutcomeFingerprint(result)!==row.content_sha256 || result.predictionId!==row.prediction_id)
    throw Error('forecast_outcome_integrity');
  return { revision: row.revision, sha256: row.result_sha256, previousSha256: row.previous_sha256, result };
}
export class V1ForecastOutcomeRepository {
  constructor(private readonly db: Db) {}
  async page(owner:string,predictionRequestId:string,beforeRevision:number|null=null){
    const prediction=await new V1RuntimeRepository(this.db).get(owner,predictionRequestId);
    if(!prediction)throw new ScenarioError('NOT_FOUND');
    if(prediction.snapshot.request.purpose!=='real_map')throw Error('forecast_real_purpose_required');
    const rows=(await sql<Row>`SELECT * FROM v1_forecast_outcome_revisions WHERE prediction_id=${prediction.id}
      AND (${beforeRevision}::integer IS NULL OR revision<${beforeRevision}::integer) ORDER BY revision DESC LIMIT 21`.execute(this.db)).rows;
    const items=rows.slice(0,20).map(saved);return {items,nextBeforeRevision:rows.length>20?items.at(-1)!.revision:null};
  }
  async history(owner: string, predictionRequestId: string) {
    const prediction = await new V1RuntimeRepository(this.db).get(owner,predictionRequestId);
    if (!prediction) throw new ScenarioError('NOT_FOUND');
    if (prediction.snapshot.request.purpose!=='real_map') throw Error('forecast_real_purpose_required');
    return (await sql<Row>`SELECT * FROM v1_forecast_outcome_revisions WHERE prediction_id=${prediction.id} ORDER BY revision`.execute(this.db)).rows.map(saved);
  }
  async refresh(owner: string, input: unknown) {
    const request = V1OutcomeRefreshSchema.parse(input), requestHash = registryHash(request);
    return this.db.transaction().execute(async tx => {
      await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-forecast-refresh:'+owner+':'+request.requestId},0))`.execute(tx);
      const previousRequest = (await sql<{ request_hash: string; prediction_id: string; revision: number }>`SELECT * FROM v1_forecast_refresh_requests
        WHERE owner_user_id=${owner}::uuid AND request_id=${request.requestId}::uuid`.execute(tx)).rows[0];
      if (previousRequest) {
        if (previousRequest.request_hash!==requestHash) throw Error('forecast_request_conflict');
        return this.read(tx,previousRequest.prediction_id,previousRequest.revision);
      }
      const prediction = await new V1RuntimeRepository(this.db).get(owner,request.predictionRequestId,tx);
      if (!prediction) throw new ScenarioError('NOT_FOUND');
      if (prediction.snapshot.request.purpose!=='real_map') throw Error('forecast_real_purpose_required');
      if (prediction.snapshot.request.realTarget.provider==='pandascore' && !(await sql`SELECT 1 FROM v1_schedule_result_bindings
        WHERE owner_user_id=${owner}::uuid AND target_request_id=${prediction.snapshot.request.realTarget.targetRequestId}::uuid`.execute(tx)).rows.length)
        throw Error('forecast_schedule_binding_required');
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-forecast-outcome:'+prediction.id},0))`.execute(tx);
      const old = (await sql<Row>`SELECT * FROM v1_forecast_outcome_revisions WHERE prediction_id=${prediction.id} ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
      if ((old?.revision??0)!==request.expectedRevision) throw new ScenarioError('CONFLICT');
      const bound = (await sql<{ match_id:string }>`SELECT result_text::jsonb->>'matchId' AS match_id FROM v1_forecast_outcome_revisions
        WHERE prediction_id=${prediction.id} AND result_text::jsonb->>'status'='linked' ORDER BY revision LIMIT 1`.execute(tx)).rows[0];
      if (bound && bound.match_id!==request.matchId) throw Error('forecast_bound_map_conflict');
      const response = (await sql<{ result: unknown }>`SELECT verify_v1_forecast_outcome(${prediction.id}::uuid,${request.matchId}::bigint,
        date_trunc('milliseconds',clock_timestamp())) AS result`.execute(tx)).rows[0]!.result;
      const result = V1ForecastOutcomeSchema.parse(response), contentSha = forecastOutcomeFingerprint(result);
      let revision = old?.revision??0;
      if (!old || old.content_sha256!==contentSha) {
        revision++; const bytes = JSON.stringify(result);
        await sql`INSERT INTO v1_forecast_outcome_revisions(prediction_id,revision,previous_sha256,result_text,result_sha256,content_sha256)
          VALUES (${prediction.id},${revision},${old?.result_sha256??null},${bytes},${registrySha(bytes)},${contentSha})`.execute(tx);
      }
      await sql`INSERT INTO v1_forecast_refresh_requests(owner_user_id,request_id,request_hash,prediction_id,revision)
        VALUES (${owner}::uuid,${request.requestId}::uuid,${requestHash},${prediction.id},${revision})`.execute(tx);
      return this.read(tx,prediction.id,revision);
    });
  }
  private async read(db: Executor, prediction: string, revision: number) {
    const row = (await sql<Row>`SELECT * FROM v1_forecast_outcome_revisions WHERE prediction_id=${prediction} AND revision=${revision}`.execute(db)).rows[0];
    if (!row) throw Error('forecast_outcome_missing');
    return saved(row);
  }
}
