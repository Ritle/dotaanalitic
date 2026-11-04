import { randomUUID } from 'node:crypto';
import { V1RuntimeRequestSchema, V1AnyRuntimeRequestSchema, V1RuntimeSnapshotSchema } from '@dota/contracts';
import { sql, type Db, type Executor } from './index.js';
import { ScenarioRepository, ScenarioError } from './scenario-repository.js';
import { V1ModelRegistry } from './v1-registry-repository.js';
import { V1DataRepository } from './v1-data-repository.js';
import { prepareReleaseHistory } from './v1-release-inventory.js';
import { registrySha, registryHash } from './v1-registry.js';
import { readV1RuntimeCode, compatibleV1Runtime } from './v1-runtime-code.js';
import { runtimeTargetReasons, computeV1RuntimeFeatures } from './v1-runtime.js';
import { bindScheduledRuntime } from './v1-scheduled-runtime.js';

type Row = { prediction_id: string; request_hash: string; snapshot_text: string; snapshot_sha256: string };
function saved(row: Row) {
  if (registrySha(row.snapshot_text) !== row.snapshot_sha256) throw Error('runtime_snapshot_integrity');
  const snapshot = V1RuntimeSnapshotSchema.parse(JSON.parse(row.snapshot_text));
  if (registryHash(snapshot.request) !== row.request_hash) throw Error('runtime_snapshot_integrity');
  return { id: row.prediction_id, sha256: row.snapshot_sha256, snapshot };
}
const clock = async (db: Executor) => (await sql<{ time: string; milliseconds: string }>`SELECT
  to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time,
  to_char(date_trunc('milliseconds',t) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS milliseconds
  FROM (SELECT clock_timestamp() AS t) clock`.execute(db)).rows[0]!;

export class V1RuntimeRepository {
  constructor(private readonly db: Db, private readonly startupCode?: Awaited<ReturnType<typeof readV1RuntimeCode>>) {}
  async get(owner: string, requestId: string, db: Executor = this.db) {
    V1RuntimeRequestSchema.shape.requestId.parse(owner); V1RuntimeRequestSchema.shape.requestId.parse(requestId);
    const row = (await sql<Row>`SELECT * FROM v1_runtime_snapshots WHERE owner_user_id=${owner} AND request_id=${requestId}`.execute(db)).rows[0];
    return row ? saved(row) : null;
  }
  async create(owner: string, input: unknown) {
    V1RuntimeRequestSchema.shape.requestId.parse(owner);
    const request = V1AnyRuntimeRequestSchema.parse(input), requestHash = registryHash(request);
    // READ COMMITTED is intentional: a lock wait must not pin an old active-model snapshot.
    return this.db.transaction().execute(async tx => {
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
      const scenario = await new ScenarioRepository(this.db).get(owner, request.scenarioId, tx);
      const scheduleBinding=request.purpose==='real_map'&&request.realTarget.provider==='pandascore'
        ?await bindScheduledRuntime(this.db,tx,owner,request.realTarget,scenario):null;
      // Serialize with an owner-reviewed completed-map association, across all target revisions.
      if(scheduleBinding)await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-schedule-result:'+owner},0))`.execute(tx);
      const gate = await new V1ModelRegistry(this.db).lockForPrediction(tx);
      const started = await clock(tx), cutoffAt = scenario.input.cutoffAt < started.milliseconds ? scenario.input.cutoffAt : started.milliseconds;
      const leagueId = scenario.input.context.leagueId;
      const providerLeagueId = leagueId ? (await sql<{ id: string | null }>`SELECT opendota_league_id::text AS id
        FROM leagues WHERE id=${leagueId}::bigint`.execute(tx)).rows[0]?.id ?? null : null;
      const reasons = runtimeTargetReasons(request, scenario, started.milliseconds, providerLeagueId);
      if(scheduleBinding&&(await sql`SELECT 1 FROM v1_schedule_result_bindings WHERE owner_user_id=${owner}::uuid
        AND provider_match_id=${scheduleBinding.target.record.request.providerMatchId}::bigint LIMIT 1`.execute(tx)).rows.length)
        reasons.push('TARGET_SERIES_ALREADY_STARTED');
      if(scheduleBinding&&(await sql<{action:string}>`SELECT event_text::jsonb#>>'{request,action}' AS action FROM v1_scheduled_lifecycle
        WHERE owner_user_id=${owner}::uuid AND provider_match_id=${scheduleBinding.target.record.request.providerMatchId}::bigint ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0]?.action==='cancelled')
        reasons.push('TARGET_OWNER_CANCELLED');
      if (request.purpose === 'real_map' && request.realTarget.provider === 'opendota') {
        if (scenario.input.context.mapNumber !== 1) reasons.push('EXPLICIT_FIRST_MAP_REQUIRED');
        // Do not issue a first-map forecast after a known map in that source series began.
        const known = await sql`SELECT 1 FROM matches m WHERE m.started_at<=clock_timestamp() AND (
          EXISTS(SELECT 1 FROM series s WHERE s.id=m.series_id AND s.provider='opendota' AND s.provider_series_id=${request.realTarget.providerSeriesId})
          OR EXISTS(SELECT 1 FROM provider_ingest_receipts r WHERE r.canonical_match_id=m.id AND r.provider='opendota'
            AND r.source_payload->>'series_id'=${request.realTarget.providerSeriesId})) LIMIT 1`.execute(tx);
        if (known.rows.length) reasons.push('TARGET_SERIES_ALREADY_STARTED');
      }
      if (gate.status === 'unavailable') reasons.push(gate.reason);
      const code = await readV1RuntimeCode();
      if (this.startupCode && registryHash(code) !== registryHash(this.startupCode)) reasons.push('SERVER_CODE_CHANGED_RESTART_REQUIRED');
      if (gate.status === 'model_eligible' && !compatibleV1Runtime(gate.artifact.freeze, code)) reasons.push('INFERENCE_CODE_MISMATCH');
      const warmup = gate.status === 'model_eligible' ? gate.artifact.plan.request.warmupFromAt : '2024-01-01T00:00:00.000Z';
      let source: unknown = null, features: unknown = null, probability: number | null = null;
      if (cutoffAt <= warmup) reasons.push('HISTORY_WINDOW_INVALID');
      else {
        // Independent, consistent SELECT-only source snapshot. Locks on scenario/registry remain
        // held until persistence. Source adapter rejects canonical facts observed after cutoff.
        try {
          const inventory = await new V1DataRepository(this.db).exportReleaseInventory({ fromAt: warmup,
            toAt: cutoffAt, snapshotAt: cutoffAt, maxMaps: 5000 }, code.code);
          const prepared = prepareReleaseHistory(inventory); source = inventory;
          const result = computeV1RuntimeFeatures(prepared.history, scenario, cutoffAt,
            gate.status === 'model_eligible' && !reasons.includes('INFERENCE_CODE_MISMATCH') ? gate.artifact : null);
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
      const gateSnapshot = gate.status === 'unavailable' ? gate : { status: gate.status, modelId: gate.modelId,
        activationEventId: gate.activationEventId, planFingerprint: gate.artifact.plan.fingerprint,
        releaseRevision: gate.releaseRevision, reportSha256: gate.reportSha256,
        candidateSha256: gate.artifact.bytes.candidateSha256, freezeSha256: gate.artifact.bytes.freezeSha256 };
      const snapshot = V1RuntimeSnapshotSchema.parse({ format: 'v1-runtime-snapshot-v1', request, scenario,
        createdAt: started.time, issuedAt: done ? finished.time : null, cutoffAt,
        status: done ? 'done' : 'unavailable', teamAWinProbability: done ? probability : null,
        reasons: [...new Set(reasons)], gate: gateSnapshot,
        code: this.startupCode ? { ...code, startupFingerprint: registryHash(this.startupCode) } : code, source, features,
        targetReview: { basis: 'owner_reviewed_event_scope', recordedAt: started.time, providerLeagueId,
          ...(scheduleBinding?{scheduleBinding}:{}) },
        warnings: ['CONDITIONAL_ON_MANUAL_LINEUPS', 'HISTORICAL_LINEUPS_RECONSTRUCTED',
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
      return saved({ prediction_id: id, request_hash: requestHash, snapshot_text: text, snapshot_sha256: sha256 });
    });
  }
}
