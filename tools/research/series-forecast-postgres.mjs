import assert from 'node:assert/strict';
import {sql} from '../../packages/db/dist/index.js';
import {FreshPageScheduleTargetRepository} from '../../packages/db/dist/schedule-page-freshness.js';
import {registryHash, registrySha} from '../../packages/db/dist/v1-registry.js';
import {scheduleFreshnessReason} from '../../packages/contracts/dist/schedule-freshness.js';
import {checkPandaSeriesResult} from '../../apps/api/dist/modules/upcoming/series-result.js';
import {prepareSeriesRehearsal} from './series-forecast-rehearsal.mjs';

const scheduleClock = sql`to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const atUs = iso => BigInt(Date.parse(iso))*1000n + BigInt((iso.match(/\.(\d+)Z$/)?.[1] ?? '').padEnd(6,'0').slice(3,6));

// The binding maps the synthetic canonical sides to the two provider teams explicitly.
export async function captureScheduledRehearsal(db,input,binding) {
  assert(!db.isTransaction,'commit witness requires independent transactions');
  assert.equal(input.target.provider,'synthetic');
  assert.equal(input.history.syntheticOnly,true);
  assert.deepEqual(Object.keys(binding).sort(),['providerTeamAId','providerTeamBId','snapshotSha256'],'unexpected binding fields');
  const id = input.target.seriesId, requestSha = registryHash({input,binding});
  const sha = await db.transaction().execute(async tx=>{
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('bo3-rehearsal:' || ${id}::text,0))`.execute(tx);
    const prior = (await sql`SELECT request_sha,receipt_sha FROM bo3_rehearsal.forecasts
      WHERE match_id=${id}::bigint`.execute(tx)).rows[0];
    if (prior) {
      assert.equal(prior.request_sha,requestSha,'conflicting series request');
      return prior.receipt_sha;
    }
    await sql`LOCK TABLE upcoming_source_observations,upcoming_page_observations IN SHARE MODE`.execute(tx);
    const preview = await new FreshPageScheduleTargetRepository(db).preview(id,tx);
    assert(preview.eligible,preview.reasons.join(','));
    const o = preview.observation, m = o.match, target = input.target;
    assert.equal(o.adapterVersion,'synthetic-target-test','synthetic schedule required');
    assert.equal(o.snapshotSha256,binding.snapshotSha256,'schedule revision mismatch');
    assert.equal(m.eventSeries?.providerEventSeriesId,target.editionId,'event edition mismatch');
    assert.equal(m.seriesBestOf,3,'scheduled format mismatch');
    assert.equal(m.scheduledAt,target.scheduledAt,'scheduled start mismatch');
    assert.equal(o.fetchedAt,target.scheduleObservedAt,'source clock mismatch');
    assert(atUs(o.recordedAt)<=BigInt(input.scenario.cutoffAtUs),'schedule recorded after cutoff');
    assert.deepEqual([binding.providerTeamAId,binding.providerTeamBId].sort(),
      m.opponents.map(t=>t.providerTeamId).sort(),'scheduled participants mismatch');
    // Separate the calculation time from the later proof that the forecasts were committed.
    const {recordedAt:preparedAt,issuedAt:provisionalTime,...calculation} =
      await prepareSeriesRehearsal(input,preview.checkedAt);
    const body = JSON.stringify({format:'bo3-pg-rehearsal-v1',preparedAt,binding,observation:o,calculation});
    const digest = registrySha(body);
    const {at} = (await sql`SELECT ${scheduleClock} AS at`.execute(tx)).rows[0];
    assert(!scheduleFreshnessReason(o.fetchedAt,at) && atUs(at)<atUs(m.scheduledAt),'schedule expired during calculation');
    await sql`INSERT INTO bo3_rehearsal.forecasts(match_id,request_sha,receipt_text,receipt_sha)
      VALUES(${id}::bigint,${requestSha},${body},${digest})`.execute(tx);
    return digest;
  });
  // The original receipt is visible before this INSERT. If the process stopped after COMMIT,
  // a retry can only record its current clock, never reconstruct an earlier issuance time.
  await sql`INSERT INTO bo3_rehearsal.commit_witnesses(match_id) VALUES(${id}::bigint)
    ON CONFLICT(match_id) DO NOTHING`.execute(db);
  const {seen} = (await sql`SELECT to_char(seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS seen
    FROM bo3_rehearsal.commit_witnesses WHERE match_id=${id}::bigint`.execute(db)).rows[0];
  return {sha256:sha,committedBy:seen};
}

// Timing review only. Synthetic provider results never count as canonical professional labels.
export async function reviewRehearsalTiming(db,id) {
  const row = (await sql`SELECT f.receipt_text,f.receipt_sha,
    to_char(w.seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS seen,
    r.observation_text,r.observation_sha256,r.terminal,r.recorded_at >= (r.observation_text::jsonb#>>'{source,fetchedAt}')::timestamptz AS source_recorded
    FROM bo3_rehearsal.forecasts f LEFT JOIN bo3_rehearsal.commit_witnesses w USING(match_id)
    LEFT JOIN LATERAL (SELECT * FROM journal_provider_result_receipts WHERE provider_match_id=f.match_id
      ORDER BY id DESC LIMIT 1) r ON true WHERE f.match_id=${id}::bigint`.execute(db)).rows[0];
  assert(row,'forecast missing');
  assert.equal(registrySha(row.receipt_text),row.receipt_sha,'forecast integrity');
  const {observation,binding,calculation,preparedAt} = JSON.parse(row.receipt_text);
  if (calculation.status !== 'ready') return 'FORECAST_UNAVAILABLE';
  if (!row.seen) return 'NO_COMMIT_WITNESS';
  if (atUs(row.seen)<atUs(preparedAt)) return 'DATABASE_CLOCK_CONFLICT';
  if (atUs(row.seen)>=atUs(observation.match.scheduledAt)) return 'NOT_BEFORE_SCHEDULED_START';
  if (!row.terminal) return 'FIRST_MAP_START_UNCONFIRMED';
  assert.equal(registrySha(row.observation_text),row.observation_sha256,'result integrity');
  const {data,source} = JSON.parse(row.observation_text);
  const match = observation.match;
  assert.equal(source.provider,'pandascore');
  assert.equal(source.endpoint,'/matches/'+match.providerMatchId);
  assert.equal(source.adapterVersion,'synthetic-bo3-result-test');
  assert.equal(source.payloadSha256,registrySha(JSON.stringify(data)),'synthetic result payload integrity');
  assert(row.source_recorded,'invalid result clock');
  if (String(data.serie_id)!==match.eventSeries.providerEventSeriesId ||
      String(data.tournament_id)!==match.tournament.providerTournamentId ||
      String(data.league_id)!==match.league.providerLeagueId) return 'RESULT_SCOPE_CHANGED';
  const result = checkPandaSeriesResult(data,{id:match.providerMatchId,teamA:binding.providerTeamAId,
    teamB:binding.providerTeamBId},source.fetchedAt);
  if (result.status !== 'verified_provider_result' || result.bestOf !== 3) return 'FIRST_MAP_START_UNCONFIRMED';
  const first = data.games.find(game=>game.position===1);
  // Use the actual position-1 game timestamp, not the series lobby time. PostgreSQL preserves microseconds.
  const {before} = (await sql`SELECT ${row.seen}::timestamptz < ${first.begin_at}::timestamptz AS before`.execute(db)).rows[0];
  return before ? 'BEFORE_FIRST_MAP' : 'NOT_BEFORE_FIRST_MAP';
}

export async function reviewRehearsalSample(db) {
  return db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
    const {rows} = await sql`SELECT match_id::text AS id FROM bo3_rehearsal.forecasts ORDER BY match_id`.execute(tx);
    const beforeFirstMap = [], exclusions = [];
    for (const {id} of rows) {
      const timing = await reviewRehearsalTiming(tx,id);
      if (timing === 'BEFORE_FIRST_MAP') beforeFirstMap.push(id);
      else exclusions.push({id,reason:timing});
    }
    return {syntheticOnly:true,observedForecasts:rows.length,beforeFirstMap,exclusions};
  });
}
