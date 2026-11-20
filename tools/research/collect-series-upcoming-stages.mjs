import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {retryAfterMilliseconds} from '../../packages/ingestion/dist/opendota/client.js';
import {PandaIdSchema} from '../../packages/ingestion/dist/pandascore/schemas.js';
import {sha} from './exposure-ledger-core.mjs';
import {reviewSeriesRegistration} from './review-series-registration.mjs';
import {countUpcomingFormats, reviewUpcomingStages, upcomingScheduleUrl} from './review-series-upcoming-stages.mjs';

const requestSpacingMs = 4_000;
const maxResponseBytes = 2 * 1024 * 1024;
const timestamp = ms => new Date(ms).toISOString();
const providerTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

async function readScheduleBody(response) {
  const chunks = [];
  let length = 0;
  const reader = response.body?.getReader();
  assert(reader, 'PandaScore schedule response body is missing');
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      assert(length <= maxResponseBytes, 'PandaScore schedule response is too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

function projectSchedule(payload, scope, stageId, fetchedAt) {
  assert(Array.isArray(payload), 'invalid PandaScore schedule response');
  const allowedStages = new Set(scope.stages.map(stage => stage.id));
  const rows = payload.map(row => {
    assert(row && typeof row === 'object', 'invalid PandaScore schedule row');
    assert(PandaIdSchema.parse(row.league_id) === scope.leagueId &&
      PandaIdSchema.parse(row.serie_id) === scope.editionId && row.videogame?.slug === 'dota-2',
    'PandaScore row is outside reviewed edition');
    const sourceStage = PandaIdSchema.parse(row.tournament_id);
    assert(allowedStages.has(sourceStage) && (stageId === null || sourceStage === stageId),
      'PandaScore row is outside reviewed stage');
    assert.equal(row.status, 'not_started', 'PandaScore row is not a future match');
    const scheduled = typeof row.scheduled_at === 'string' && providerTime.test(row.scheduled_at)
      ? Date.parse(row.scheduled_at) : NaN;
    assert(scheduled >= Date.parse(scope.windowStart) && scheduled < Date.parse(scope.windowEnd) &&
      scheduled > fetchedAt, 'PandaScore row is outside reviewed upcoming schedule');
    const bestOf = row.number_of_games;
    assert(Number.isSafeInteger(bestOf) && bestOf > 0, 'invalid PandaScore series format');
    assert(Array.isArray(row.opponents) && row.opponents.length <= 2, 'invalid PandaScore opponents');
    const teamIds = row.opponents.map(item => {
      assert.equal(item?.type, 'Team', 'PandaScore opponent is not a team');
      return PandaIdSchema.parse(item.opponent?.id);
    }).sort();
    assert.equal(new Set(teamIds).size, teamIds.length, 'duplicate PandaScore opponent');
    return {matchId: PandaIdSchema.parse(row.id), editionId: scope.editionId, stageId: sourceStage,
      bestOf, status: row.status, scheduledAt: timestamp(scheduled), teamIds};
  }).sort((left, right) => left.matchId.localeCompare(right.matchId, 'en'));
  assert.equal(new Set(rows.map(row => row.matchId)).size, rows.length, 'duplicate PandaScore match');
  return rows;
}

class PandaScoreUpcomingScheduleClient {
  #nextAt = 0;
  #token;

  constructor(apiToken, {fetcher = globalThis.fetch, now = Date.now, sleep = delay} = {}) {
    this.#token = apiToken?.trim();
    assert(this.#token && /^[!-~]{1,4096}$/u.test(this.#token), 'PandaScore credential unavailable');
    this.fetcher = fetcher;
    this.now = now;
    this.sleep = sleep;
  }

  async getSchedule(scope, stageId = null) {
    const url = upcomingScheduleUrl(scope.editionId, stageId);
    const attemptStatuses = [];
    let requestedAt;
    for (let attempt = 0; attempt < 2; attempt++) {
      const waitMs = this.#nextAt - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      requestedAt ??= timestamp(this.now());
      const response = await this.fetcher(url, {
        headers: {Authorization: 'Bearer ' + this.#token, Accept: 'application/json'},
        redirect: 'error',
        signal: AbortSignal.timeout(18_000),
      });
      const status = response.status;
      attemptStatuses.push(status);
      if (status !== 200) {
        await response.body?.cancel();
        assert(attempt === 0 && (status === 429 || status >= 500), 'PandaScore schedule HTTP ' + status);
        const retryMs = retryAfterMilliseconds(response.headers.get('retry-after'), this.now());
        assert(retryMs === null || retryMs <= 15_000, 'PandaScore requested a longer pause');
        this.#nextAt = this.now() + Math.max(requestSpacingMs, retryMs ?? 0);
        continue;
      }
      const body = await readScheduleBody(response);
      const fetchedAt = this.now();
      this.#nextAt = fetchedAt + requestSpacingMs;
      const rows = projectSchedule(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body)),
        scope, stageId, fetchedAt);
      const page = Number(url.searchParams.get('page'));
      const perPage = Number(url.searchParams.get('per_page'));
      const link = response.headers.get('link') ?? '';
      assert(response.headers.get('x-page') === String(page) &&
        response.headers.get('x-per-page') === String(perPage) &&
        response.headers.get('x-total') === String(rows.length) &&
        rows.length <= perPage && !/;\s*rel\s*=\s*"?next\b/iu.test(link),
      'PandaScore schedule does not fit on one complete page');
      return {rows, receipt: {url: url.href, requestedAt, fetchedAt: timestamp(fetchedAt), attemptStatuses,
        payloadSha256: sha(body), page, perPage, total: rows.length, normalizedSha256: sha(JSON.stringify(rows))}};
    }
    throw new Error('PandaScore schedule request failed');
  }
}

function compareSchedules(expected, observed) {
  const expectedById = new Map(expected.map(row => [row.matchId, row]));
  const actualById = new Map(observed.map(row => [row.matchId, row]));
  const missing = [...expectedById.keys()].filter(matchId => !actualById.has(matchId));
  const extra = [...actualById.keys()].filter(matchId => !expectedById.has(matchId));
  const changed = [...expectedById.keys()].filter(matchId => actualById.has(matchId) &&
    JSON.stringify(expectedById.get(matchId)) !== JSON.stringify(actualById.get(matchId)));
  return {missing, extra, changed, identical: actualById.size === observed.length &&
    missing.length + extra.length + changed.length === 0};
}

// Local research command. Persist only projected schedule facts and transport receipts.
export async function collectUpcomingStages(plan, policy, editionId, apiToken, dependencies = {}) {
  const {now = Date.now, loadEvidence} = dependencies;
  const reviewed = await reviewSeriesRegistration(plan, policy, timestamp(now()), loadEvidence);
  const scope = reviewed.editions.find(entry => entry.editionId === editionId);
  assert(scope && scope.issues.length === 0, 'edition scope is not verified');
  assert(now() < Date.parse(scope.windowEnd), 'reviewed edition window has ended');
  const client = new PandaScoreUpcomingScheduleClient(apiToken, dependencies);
  const edition = await client.getSchedule(scope);
  const stageChecks = [];
  const stageRows = [];
  for (const stage of scope.stages) {
    const {rows, receipt} = await client.getSchedule(scope, stage.id);
    stageRows.push(...rows);
    stageChecks.push({stageId: stage.id, name: stage.name ?? stage.id, organizer: null,
      formatCounts: countUpcomingFormats(rows), sourceMatchesOrganizer: null, ...receipt,
      matchIds: rows.map(row => row.matchId),
      comparedToEdition: compareSchedules(edition.rows.filter(row => row.stageId === stage.id), rows)});
  }
  const {leagueId, windowStart} = scope;
  const beforeRegistrationWindow = [edition.receipt, ...stageChecks]
    .every(receipt => Date.parse(receipt.fetchedAt) < Date.parse(windowStart));
  const report = {format: 's3-09-upcoming-stage-membership-audit-v1', editionId, leagueId, windowStart,
    organizerSources: {plan: scope.organizerSource}, edition: {...edition.receipt, rows: edition.rows},
    stageChecks, comparedToUnionOfStages: compareSchedules(edition.rows, stageRows), beforeRegistrationWindow,
    providerSnapshotGuaranteed: false, playedBo3: null, observedCoverage: null,
    registrationAllowed: false, outcomeCollectionAllowed: false};
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  const sha256 = sha(bytes);
  const review = await reviewUpcomingStages(bytes, sha256, plan, policy, loadEvidence);
  return {bytes, sha256, review};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [planPath, editionId, outputPath, ...extra] = process.argv.slice(2);
  assert(planPath && editionId && outputPath && extra.length === 0,
    'usage: collect-series-upcoming-stages.mjs PLAN.json EDITION_ID NEW_AUDIT.json');
  assert(!existsSync(outputPath), 'schedule audit output already exists');
  const [plan, policy] = await Promise.all([
    readFile(planPath, 'utf8'),
    readFile(new URL('./series-validation-policy.json', import.meta.url), 'utf8'),
  ]);
  const result = await collectUpcomingStages(JSON.parse(plan), JSON.parse(policy), editionId, process.env.PANDASCORE_API_TOKEN);
  await writeFile(outputPath, result.bytes, {flag: 'wx'});
  console.log(JSON.stringify({file: outputPath, sha256: result.sha256, ...result.review}, null, 2));
  if (!result.review.scheduleMatches) process.exitCode = 1;
}
