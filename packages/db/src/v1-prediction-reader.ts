import { V1PredictionViewSchema, V1PredictionHistorySchema, V1PredictionFeatureViewSchema,
  V1PredictionSourceViewSchema, V1PredictionGateViewSchema, V1_FEATURE_PROFILE,
  V1ScheduledPredictionCreateSchema,V1ScheduledPredictionViewSchema } from '@dota/contracts';
import { sql, type Db } from './index.js';
import { ScenarioError } from './scenario-repository.js';
import { V1RuntimeRepository } from './v1-runtime-repository.js';
import { readV1RuntimeCode } from './v1-runtime-code.js';
import {V1ScheduleTargetRepository} from './v1-schedule-target.js';

function predictionProjection(saved: NonNullable<Awaited<ReturnType<V1RuntimeRepository['get']>>>) {
  const s = saved.snapshot, gate = V1PredictionGateViewSchema.parse(s.gate);
  const source = s.source === null ? null : V1PredictionSourceViewSchema.parse(s.source);
  const features = s.features === null ? null : V1PredictionFeatureViewSchema.parse(s.features);
  return { id: saved.id, requestId: s.request.requestId, snapshotSha256: saved.sha256,
    purpose: s.request.purpose, stage: 'pre_match', scenario: s.scenario, createdAt: s.createdAt, issuedAt: s.issuedAt,
    cutoffAt: s.cutoffAt, status: s.status, teamAWinProbability: s.teamAWinProbability, reasons: s.reasons, warnings: s.warnings,
    targetScope: s.request.targetScope, model: { id: gate.modelId, eligibleAtCalculation: gate.status === 'model_eligible',
      featureProfile: V1_FEATURE_PROFILE, candidateSha256: gate.candidateSha256 ?? null,
      freezeSha256: gate.freezeSha256 ?? null, reportSha256: gate.reportSha256 ?? null },
    history: source ? { sourceFingerprint: source.fingerprint, ...source.source.request,
      identityRevision: source.source.identityRevision, remoteCompleteness: 'unknown', tiers: 'all_verified_pro' } : null,
    coverage: features?.coverage ?? null, players: features ? { teamA: features.teamA, teamB: features.teamB } : null };
}
export function predictionView(saved: NonNullable<Awaited<ReturnType<V1RuntimeRepository['get']>>>) {
  return V1PredictionViewSchema.parse(predictionProjection(saved));
}
export function scheduledPredictionView(saved:NonNullable<Awaited<ReturnType<V1RuntimeRepository['get']>>>){
  const r=saved.snapshot.request;
  if(r.purpose!=='real_map'||r.realTarget.provider!=='pandascore')throw new ScenarioError('NOT_FOUND');
  return V1ScheduledPredictionViewSchema.parse({...predictionProjection(saved),target:r.realTarget});
}
/** HTTP-facing adapter; startup fingerprint protects a long-running process after code rebuilds. */
export class V1PredictionService {
  private calculating = false;
  private constructor(private readonly db: Db, private readonly runtime: V1RuntimeRepository) {}
  static async open(db: Db) { return new V1PredictionService(db, new V1RuntimeRepository(db, await readV1RuntimeCode())); }
  async create(owner: string, request: unknown) {
    // A calculation uses a transaction plus a separate history connection. Bound admission
    // before taking pool slots, so queued registry locks cannot exhaust the single-owner pool.
    if (this.calculating) throw Error('runtime_request_busy');
    this.calculating = true;
    try { return predictionView(await this.runtime.create(owner, request)); }
    finally { this.calculating = false; }
  }
  async createScheduled(owner:string,targetId:string,input:unknown){
    if(this.calculating)throw Error('runtime_request_busy');this.calculating=true;
    try{
      const request=V1ScheduledPredictionCreateSchema.parse(input),target=await new V1ScheduleTargetRepository(this.db).get(owner,targetId);
      if(target.sha256!==request.targetSha256)throw Error('scheduled_target_reference_mismatch');
      const {targetSha256,...rest}=request;
      return scheduledPredictionView(await this.runtime.create(owner,{...rest,purpose:'real_map',realTarget:{provider:'pandascore',bindingVersion:1,
        providerMatchId:target.record.request.providerMatchId,mapNumber:1,targetRequestId:target.record.request.requestId,targetSha256}}));
    }finally{this.calculating=false;}
  }
  async getScheduled(owner:string,targetId:string,requestId:string){
    const result=await this.runtime.get(owner,requestId),r=result?.snapshot.request;
    if(!result||r?.purpose!=='real_map'||r.realTarget.provider!=='pandascore'||r.realTarget.targetRequestId!==targetId)throw new ScenarioError('NOT_FOUND');
    return scheduledPredictionView(result);
  }
  async scheduledHistory(owner:string,targetId:string,offset:number){
    await new V1ScheduleTargetRepository(this.db).get(owner,targetId);
    const rows=(await sql`SELECT p.id,s.request_id AS "requestId",p.scenario_revision AS "scenarioRevision",p.status,
      to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
      FROM v1_runtime_snapshots s JOIN prediction_runs p ON p.id=s.prediction_id
      WHERE s.owner_user_id=${owner}::uuid AND s.schedule_target_request_id=${targetId}::uuid
      ORDER BY p.created_at DESC,p.id DESC LIMIT 21 OFFSET ${offset}`.execute(this.db)).rows;
    return V1PredictionHistorySchema.parse({items:rows.slice(0,20),hasMore:rows.length>20});
  }
  async get(owner: string, scenarioId: string, requestId: string) {
    const result = await this.runtime.get(owner, requestId);
    if (!result || result.snapshot.scenario.id !== scenarioId || result.snapshot.request.purpose !== 'what_if_single_map') throw new ScenarioError('NOT_FOUND');
    return predictionView(result);
  }
  async history(owner: string, scenarioId: string, offset: number) {
    if (!(await sql`SELECT 1 FROM scenarios WHERE id=${scenarioId}::uuid AND owner_user_id=${owner}::uuid`.execute(this.db)).rows.length)
      throw new ScenarioError('NOT_FOUND');
    const rows = (await sql`SELECT p.id,s.request_id AS "requestId",p.scenario_revision AS "scenarioRevision",p.status,
      to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
      FROM v1_runtime_snapshots s JOIN prediction_runs p ON p.id=s.prediction_id
      WHERE s.owner_user_id=${owner}::uuid AND p.scenario_id=${scenarioId}::uuid
        AND s.snapshot_text::jsonb#>>'{request,purpose}'='what_if_single_map'
      ORDER BY p.created_at DESC,p.id DESC LIMIT 21 OFFSET ${offset}`.execute(this.db)).rows;
    return V1PredictionHistorySchema.parse({ items: rows.slice(0, 20), hasMore: rows.length > 20 });
  }
}
