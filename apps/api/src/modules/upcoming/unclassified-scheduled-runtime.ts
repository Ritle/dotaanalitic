import { randomUUID,createHash } from 'node:crypto';
import {readFile} from 'node:fs/promises';
import { V1RuntimeRequestSchema, V1AnyRuntimeRequestSchema, V1RuntimeSnapshotSchema } from '@dota/contracts';
import { sql, type Db, type Executor } from '@dota/db';
import { ScenarioRepository, ScenarioError } from '@dota/db';
import { PredictionModelRegistry, runtimeModelWarmup, runtimeModelCompatible, computeRuntimeModelFeatures, runtimeModelSnapshot } from '@dota/db';
import { V1DataRepository } from '@dota/db';
import { prepareReleaseHistory } from '@dota/db';
import { registrySha, registryHash } from '@dota/db';
import { readV1RuntimeCode } from '../../../../../packages/db/dist/v1-runtime-code.js';
import { runtimeTargetReasons } from '../../../../../packages/db/dist/v1-runtime.js';
import { bindPageScheduledRuntime } from '@dota/db';
import { V1RuntimeRepository } from '@dota/db';

const clock = async (db: Executor) => (await sql<{ time: string; milliseconds: string }>`SELECT
  to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time,
  to_char(date_trunc('milliseconds',t) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS milliseconds
  FROM (SELECT clock_timestamp() AS t) clock`.execute(db)).rows[0]!;

/** Versioned schedule orchestration; model/history/gate arithmetic is unchanged. */
export class UnclassifiedScheduledRuntimeRepository extends V1RuntimeRepository {
  constructor(private readonly pagesDb: Db, private readonly pagesCode?: Awaited<ReturnType<typeof readV1RuntimeCode>>) { super(pagesDb,pagesCode); }
  async create(owner: string, input: unknown) {
    V1RuntimeRequestSchema.shape.requestId.parse(owner);
    const request = V1AnyRuntimeRequestSchema.parse(input);
    if(request.targetScope!==null||(request.purpose==='real_map'&&request.realTarget.provider!=='pandascore'))throw Error('scheduled_unclassified_request_invalid');
    const requestHash = registryHash(request);
    // READ COMMITTED is intentional: a lock wait must not pin an old active-model snapshot.
    return this.pagesDb.transaction().execute(async tx => {
      await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-runtime:' + owner + ':' + request.requestId},0))`.execute(tx);
      const previous = await this.get(owner, request.requestId, tx);
      if (previous) {
        if (registryHash(previous.snapshot.request) !== requestHash) throw Error('runtime_request_conflict');
        return previous;
      }
      const row = (await sql<{ revision: number }>`SELECT revision FROM scenarios WHERE id=${request.scenarioId}
        AND owner_user_id=${owner} FOR SHARE`.execute(tx)).rows[0];
      if (!row) throw new ScenarioError('NOT_FOUND');
      if (row.revision !== request.expectedRevision) throw new ScenarioError('CONFLICT');
      const scenario = await new ScenarioRepository(this.pagesDb).get(owner, request.scenarioId, tx);
      const scheduleBinding=request.purpose==='real_map'&&request.realTarget.provider==='pandascore'
        ?await bindPageScheduledRuntime(this.pagesDb,tx,owner,request.realTarget,scenario):null;
      // Serialize with an owner-reviewed completed-map association, across all target revisions.
      if(scheduleBinding)await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-schedule-result:'+owner},0))`.execute(tx);
      const gate = await new PredictionModelRegistry(this.pagesDb).lockForPrediction(tx);
      const started = await clock(tx), cutoffAt = scenario.input.cutoffAt < started.milliseconds ? scenario.input.cutoffAt : started.milliseconds;
      const leagueId = scenario.input.context.leagueId;
      const providerLeagueId = leagueId ? (await sql<{ id: string | null }>`SELECT opendota_league_id::text AS id
        FROM leagues WHERE id=${leagueId}::bigint`.execute(tx)).rows[0]?.id ?? null : null;
      // Explicit owner policy: tier is optional for new scheduled forecasts. All temporal gates remain.
      const reasons = runtimeTargetReasons(request, scenario, started.milliseconds, providerLeagueId).filter(r=>r!=='TIER1_SCOPE_NOT_REVIEWED');
      if(scheduleBinding&&(await sql`SELECT 1 FROM v1_schedule_result_bindings WHERE owner_user_id=${owner}::uuid
        AND provider_match_id=${scheduleBinding.target.record.request.providerMatchId}::bigint LIMIT 1`.execute(tx)).rows.length)
        reasons.push('TARGET_SERIES_ALREADY_STARTED');
      if(scheduleBinding&&(await sql<{action:string}>`SELECT event_text::jsonb#>>'{request,action}' AS action FROM v1_scheduled_lifecycle
        WHERE owner_user_id=${owner}::uuid AND provider_match_id=${scheduleBinding.target.record.request.providerMatchId}::bigint ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0]?.action==='cancelled')
        reasons.push('TARGET_OWNER_CANCELLED');
      if (gate.status === 'unavailable') reasons.push(gate.reason);
      const code = await readV1RuntimeCode();
      if (this.pagesCode && registryHash(code) !== registryHash(this.pagesCode)) reasons.push('SERVER_CODE_CHANGED_RESTART_REQUIRED');
      if (gate.status === 'model_eligible' && !runtimeModelCompatible(gate, code)) reasons.push('INFERENCE_CODE_MISMATCH');
      const warmup = runtimeModelWarmup(gate);
      let source: unknown = null, features: unknown = null, probability: number | null = null;
      if (cutoffAt <= warmup) reasons.push('HISTORY_WINDOW_INVALID');
      else {
        // Independent, consistent SELECT-only source snapshot. Locks on scenario/registry remain
        // held until persistence. Source adapter rejects canonical facts observed after cutoff.
        try {
          const inventory = await new V1DataRepository(this.pagesDb).exportReleaseInventory({ fromAt: warmup,
            toAt: cutoffAt, snapshotAt: cutoffAt, maxMaps: 5000 }, code.code);
          const prepared = prepareReleaseHistory(inventory); source = inventory;
          const result = computeRuntimeModelFeatures(prepared.history, scenario, cutoffAt,
            gate.status === 'model_eligible' && !reasons.includes('INFERENCE_CODE_MISMATCH') ? gate : null);
          features = result.features; probability = result.probability; reasons.push(...result.reasons);
        } catch (error) {
          // Bounded failures persist an unavailable attempt; never substitute a truncated history.
          const reason = error instanceof Error ? error.message : '';
          reasons.push(reason.includes('limit') ? 'HISTORY_INVENTORY_LIMIT' : 'HISTORY_EVIDENCE_INVALID');
        }
      }
      const finished = await clock(tx);
      if (scenario.input.scheduledAt && Date.parse(finished.time) >= Date.parse(scenario.input.scheduledAt)) reasons.push('TARGET_ALREADY_STARTED');
      if (!reasons.length && probability === null) reasons.push('INFERENCE_UNAVAILABLE');
      const done = reasons.length === 0;
      const gateSnapshot = runtimeModelSnapshot(gate);
      const snapshot = V1RuntimeSnapshotSchema.parse({ format: 'v1-runtime-snapshot-v1', request, scenario,
        createdAt: started.time, issuedAt: done ? finished.time : null, cutoffAt,
        status: done ? 'done' : 'unavailable', teamAWinProbability: done ? probability : null,
        reasons: [...new Set(reasons)], gate: gateSnapshot,
        code: this.pagesCode ? { ...code, startupFingerprint: registryHash(this.pagesCode) } : code, source, features,
        targetReview: { basis: 'event_tier_unverified', policy:'interactive-optional-tier-v1', orchestrationSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), recordedAt: started.time, providerLeagueId,
          ...(scheduleBinding?{scheduleBinding}:{}) },
        warnings: ['TOURNAMENT_TIER_UNVERIFIED', 'CONDITIONAL_ON_MANUAL_LINEUPS', 'HISTORICAL_LINEUPS_RECONSTRUCTED',
          'ALL_VERIFIED_PRO_TIERS_HISTORY', 'LOCAL_HISTORY_REMOTE_COMPLETENESS_UNKNOWN',
          request.purpose === 'real_map' ? 'REAL_MAP_BINDING_PENDING' : 'WHAT_IF_NOT_PROSPECTIVE'] });
      const text = JSON.stringify(snapshot), sha256 = registrySha(text), id = randomUUID();
      await sql`INSERT INTO prediction_runs(id,scenario_id,scenario_revision,stage,model_version_id,status,cutoff_at,
        input_hash,data_revision,input_snapshot,feature_snapshot,coverage,quality,warnings,team_a_win_probability,
        computed_at,created_at,v1_request_id,issued_at)
        VALUES (${id},${scenario.id},${scenario.revision},'pre_match',${gate.modelId},${snapshot.status},${cutoffAt}::timestamptz,
          ${scenario.inputHash},${registryHash(source)},${JSON.stringify(scenario.input)}::jsonb,
          ${JSON.stringify(features ?? {})}::jsonb,${JSON.stringify({ sourceCaptured: source !== null })}::jsonb,
          ${JSON.stringify(gateSnapshot)}::jsonb,${JSON.stringify(snapshot.warnings)}::jsonb,${snapshot.teamAWinProbability},
          ${finished.time}::timestamptz,${started.time}::timestamptz,${request.requestId},${snapshot.issuedAt}::timestamptz)`.execute(tx);
      await sql`INSERT INTO v1_runtime_snapshots(prediction_id,owner_user_id,request_id,request_hash,snapshot_text,snapshot_sha256,schedule_target_request_id)
        VALUES (${id},${owner},${request.requestId},${requestHash},${text},${sha256},${scheduleBinding?.target.record.request.requestId??null}::uuid)`.execute(tx);
      return (await this.get(owner,request.requestId,tx))!;
    });
  }
}

import {V1ScheduledPredictionCreateSchema} from '@dota/contracts';
import {PageScheduleTargetRepository,scheduledPredictionView,predictionView} from '@dota/db';
/** Optional-tier scheduled entry point. Prior scoped forecasts retain their original executor. */
export class UnclassifiedScheduledForecastService {
 private calculating=false;
 constructor(private readonly db:Db){}
 async create(owner:string,input:unknown){
  if(this.calculating)throw Error('runtime_request_busy');this.calculating=true;
  try{return predictionView(await new UnclassifiedScheduledRuntimeRepository(this.db).create(owner,input));}
  finally{this.calculating=false;}
 }
 async createScheduled(owner:string,targetId:string,input:unknown){
  if(this.calculating)throw Error('runtime_request_busy');this.calculating=true;
  try{
   const request=V1ScheduledPredictionCreateSchema.parse(input),target=await new PageScheduleTargetRepository(this.db).get(owner,targetId);
   if(target.sha256!==request.targetSha256)throw Error('scheduled_target_reference_mismatch');
   const {targetSha256,...rest}=request;
   return scheduledPredictionView(await new UnclassifiedScheduledRuntimeRepository(this.db).create(owner,{...rest,purpose:'real_map',realTarget:{provider:'pandascore',bindingVersion:1,
    providerMatchId:target.record.request.providerMatchId,mapNumber:1,targetRequestId:target.record.request.requestId,targetSha256}}));
  }finally{this.calculating=false;}
 }
}
