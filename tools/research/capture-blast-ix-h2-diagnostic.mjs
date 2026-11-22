/** Bounded collection for one archived, non-release H2 comparison. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createDatabase} from '../../packages/db/dist/index.js';
import {OpenDotaClient, OpenDotaError, PostgresProviderBudget, parseSource, completedObservation} from '../../packages/ingestion/dist/index.js';

const leagueId = '20208';
const maximumMaps = 35;
const [directory, ...extra] = process.argv.slice(2);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = async (name, value) => {
  const bytes = JSON.stringify(value) + '\n';
  await writeFile(join(directory, name), bytes, {flag: 'wx'});
  return sha(bytes);
};

let db;
try {
  assert(/^\.tools\/blast-ix-h2-diagnostic-[a-z0-9-]+$/.test(directory ?? '') && !extra.length, 'output_scope');
  assert(process.env.DATABASE_URL, 'database_required');
  const targetDb = new URL(process.env.DATABASE_URL);
  assert(['localhost','127.0.0.1'].includes(targetDb.hostname), 'local_database_required');
  await mkdir(directory);
  db = createDatabase(targetDb.href);
  const limits = {
    rpm: Number(process.env.OPENDOTA_RPM_BUDGET ?? 45),
    daily: Number(process.env.OPENDOTA_DAILY_BUDGET ?? 2000),
    monthly: Number(process.env.OPENDOTA_MONTHLY_BUDGET ?? 45000)
  };
  const budget = new PostgresProviderBudget(db, limits);
  const client = new OpenDotaClient({attempts: 1, maxRequests: maximumMaps + 1,
    requestsPerMinute: Math.min(30, limits.rpm), timeoutMs: 15000, maxWaitMs: 0}, {budget});
  const list = await client.getLeagueMatchDiscovery(leagueId);
  const raw = JSON.parse(list.rawBody);
  const completedIds = new Set(raw.filter(map => typeof map.radiant_win === 'boolean').map(map => String(map.match_id)));
  const cohort = list.data.filter(map => completedIds.has(map.match_id));
  assert(cohort.length > 0 && cohort.length <= maximumMaps, 'cohort_bound');
  assert.equal(new Set(cohort.map(map => map.match_id)).size, cohort.length, 'duplicate_map');
  assert(cohort.every(map => map.leagueid === leagueId && map.start_time !== null), 'cohort_scope');
  const cohortSha256 = await save('cohort.json', {format: 'blast-ix-h2-diagnostic-cohort-v1', leagueId,
    source: list.source, rows: cohort, maximumMaps, basis: 'opendota_completed_rows_visible_at_capture', independentTest: false});
  console.log(JSON.stringify({status: 'cohort_fixed', maps: cohort.length, cohortSha256}));

  const collected = [], labels = [], missing = [];
  for (const [index, row] of cohort.entries()) {
    const id = row.match_id;
    try {
      const d = await client.getMatchSource(id);
      const {match: map} = parseSource(d, id);
      if (!map || map.leagueid !== leagueId || map.start_time !== row.start_time || !completedObservation(map, d.source.fetchedAt)) {
        missing.push({id, reason: 'INVALID_DETAIL_OR_COMPLETION'});
        continue;
      }
      if ((row.series_id !== null && map.series_id !== null && map.series_id !== row.series_id) ||
          (row.radiant_team_id !== null && map.radiant_team_id !== row.radiant_team_id) ||
          (row.dire_team_id !== null && map.dire_team_id !== row.dire_team_id)) {
        missing.push({id, reason: 'PROVIDER_CONTEXT_CONFLICT'});
        continue;
      }
      collected.push({id, source: d.source, startTime: map.start_time, seriesId: map.series_id ?? row.series_id,
        radiantTeamId: map.radiant_team_id, direTeamId: map.dire_team_id,
        players: (map.players ?? []).map(p => ({slot: p.player_slot ?? null, accountId: p.account_id ?? null, heroId: p.hero_id ?? null}))});
      const same = raw.find(item => String(item.match_id) === id);
      if (typeof map.radiant_win === 'boolean' && map.radiant_win === same.radiant_win) labels.push({id, radiantWon: map.radiant_win});
    } catch (error) {
      const reason = error instanceof OpenDotaError ? error.code : 'DETAIL_VALIDATION_FAILED';
      missing.push({id, reason});
      if (['source_rate_limited','request_budget_exhausted','source_http_error'].includes(reason)) {
        missing.push(...cohort.slice(index + 1).map(map => ({id: map.match_id, reason: 'STOPPED_AT_PROVIDER_LIMIT_OR_HTTP_ERROR'})));
        break;
      }
    }
  }
  const detailsSha256 = await save('details.json', {cohortSha256, collected, missing});
  const labelsSha256 = await save('outcomes.json', {cohortSha256, detailsSha256, labels});
  console.log(JSON.stringify({status: 'archived', requests: client.requestsUsed, details: collected.length,
    labels: labels.length, missing: missing.length, detailsSha256, labelsSha256}));
} catch (error) {
  console.error(JSON.stringify({status: 'blocked', reason: error instanceof OpenDotaError ? error.code : error.code ?? error.message}));
  process.exitCode = 1;
} finally { await db?.destroy(); }
