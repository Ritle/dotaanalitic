import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CatalogIdSchema as id} from '../../packages/contracts/dist/catalog.js';
import {sha} from './exposure-ledger-core.mjs';
import {reviewSeriesRegistration} from './review-series-registration.mjs';

const {z} = createRequire(new URL('../../packages/contracts/package.json', import.meta.url))('zod');
const time = z.iso.datetime();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().nonnegative().safe();
const positive = count.positive();
const receipt = z.object({
  url: z.url(),
  requestedAt: time,
  fetchedAt: time,
  attemptStatuses: z.array(z.number().int().min(100).max(599)).nonempty(),
  payloadSha256: digest,
  page: z.literal(1),
  perPage: positive.max(100),
  total: count,
  normalizedSha256: digest,
}).strict();
const scheduledMatch = z.object({
  matchId: id,
  editionId: id,
  stageId: id,
  bestOf: positive,
  status: z.literal('not_started'),
  scheduledAt: time,
  teamIds: z.array(id).max(2),
}).strict();
const comparison = z.object({
  missing: z.array(id), extra: z.array(id), changed: z.array(id), identical: z.boolean(),
}).strict();
const audit = z.object({
  format: z.literal('s3-09-upcoming-stage-membership-audit-v1'),
  previousAudit: z.object({path: z.string().min(1), sha256: digest}).strict().optional(),
  editionId: id,
  leagueId: id,
  windowStart: time,
  organizerSources: z.object({schedule: z.url(), editionAnnouncement: z.url(), format: z.url(), plan: z.url()}).partial().strict(),
  edition: receipt.extend({rows: z.array(scheduledMatch)}),
  stageChecks: z.array(receipt.extend({
    stageId: id,
    name: z.string().min(1),
    organizer: z.object({plannedBo3: count, plannedBo5: count}).strict().nullable(),
    formatCounts: z.record(z.string().regex(/^[1-9]\d*$/u), count),
    sourceMatchesOrganizer: z.boolean().nullable(),
    matchIds: z.array(id),
    comparedToEdition: comparison,
  })),
  comparedToPreviousEdition: comparison.optional(),
  comparedToUnionOfStages: comparison,
  beforeRegistrationWindow: z.boolean(),
  providerSnapshotGuaranteed: z.literal(false),
  playedBo3: z.null(),
  observedCoverage: z.null(),
  registrationAllowed: z.literal(false),
  outcomeCollectionAllowed: z.literal(false),
}).strict();

export function upcomingScheduleUrl(editionId, stageId = null, pageSize = 100) {
  const path = stageId === null ? '/series/' + id.parse(editionId) + '/matches/upcoming'
    : '/tournaments/' + id.parse(stageId) + '/matches';
  const expected = new URL(path, 'https://api.pandascore.co');
  expected.search = new URLSearchParams({
    page: '1', per_page: String(pageSize), sort: 'scheduled_at,id',
  });
  if (stageId !== null) expected.searchParams.set('filter[status]', 'not_started');
  return expected;
}

function verifyReceipt(source, expected, length) {
  const url = new URL(source.url);
  expected.searchParams.sort();
  url.searchParams.sort();
  assert.equal(url.href, expected.href, 'unexpected PandaScore schedule endpoint');
  assert.equal(source.attemptStatuses.at(-1), 200, 'schedule response was not successful');
  assert(Date.parse(source.requestedAt) <= Date.parse(source.fetchedAt), 'schedule receipt precedes its request');
  assert(source.total === length && source.total <= source.perPage, 'schedule receipt does not cover one whole page');
}

export const countUpcomingFormats = rows => Object.fromEntries(Object.entries(Object.groupBy(rows, row => row.bestOf))
  .map(([format, matches]) => [format, matches.length]));

function compareStage(stage, expectedRows) {
  const expectedById = new Map(expectedRows.map(row => [row.matchId, row]));
  const observedIds = new Set(stage.matchIds);
  const duplicate = stage.matchIds.length !== observedIds.size;
  const missing = [...expectedById.keys()].filter(matchId => !observedIds.has(matchId));
  const extra = [...observedIds].filter(matchId => !expectedById.has(matchId));
  const membershipMatches = !duplicate && missing.length === 0 && extra.length === 0;
  const observedRows = membershipMatches ? stage.matchIds.map(matchId => expectedById.get(matchId)) : null;
  const metadataMatches = observedRows === null ? null
    : sha(JSON.stringify(observedRows)) === stage.normalizedSha256 &&
      observedRows.every(row => Date.parse(row.scheduledAt) > Date.parse(stage.fetchedAt));
  const formats = countUpcomingFormats(expectedRows);
  const formatCountsMatch = observedRows === null ? null
    : JSON.stringify(formats) === JSON.stringify(stage.formatCounts);
  const organizerMatches = stage.organizer === null ? null
    : (formats[3] ?? 0) === stage.organizer.plannedBo3 &&
      (formats[5] ?? 0) === stage.organizer.plannedBo5 &&
      expectedRows.length === stage.organizer.plannedBo3 + stage.organizer.plannedBo5;
  return {stageId: stage.stageId, matchCount: expectedRows.length, duplicate, missing, extra,
    membershipMatches, metadataMatches, formatCountsMatch, organizerMatches};
}

// Replay normalized schedule evidence. Raw payload hashes remain source receipts.
export async function reviewUpcomingStages(bytes, expectedSha, plan, policy, loadEvidence) {
  assert.equal(sha(bytes), digest.parse(expectedSha), 'stage audit digest mismatch');
  const {editionId, leagueId, windowStart, edition, stageChecks} = audit.parse(JSON.parse(bytes.toString('utf8')));
  const receipts = [edition, ...stageChecks];
  const startedAt = new Date(Math.min(...receipts.map(source => Date.parse(source.requestedAt)))).toISOString();
  const observedAt = new Date(Math.max(...receipts.map(source => Date.parse(source.fetchedAt)))).toISOString();
  const review = await reviewSeriesRegistration(plan, policy, startedAt, loadEvidence);
  const scope = review.editions.find(entry => entry.editionId === editionId);
  assert(scope?.leagueId === leagueId && scope.issues.length === 0 &&
    Date.parse(scope.windowStart) === Date.parse(windowStart), 'edition scope was not verified before collection');
  verifyReceipt(edition, upcomingScheduleUrl(editionId, null, edition.perPage), edition.rows.length);
  assert.equal(sha(JSON.stringify(edition.rows)), edition.normalizedSha256, 'edition metadata digest mismatch');
  assert.equal(new Set(edition.rows.map(row => row.matchId)).size, edition.rows.length, 'duplicate edition match');

  const expectedStageIds = new Set(scope.stages.map(stage => stage.id));
  const rowsByStage = Map.groupBy(edition.rows, row => row.stageId);
  for (const row of edition.rows) {
    const scheduledAt = Date.parse(row.scheduledAt);
    assert(row.editionId === editionId && expectedStageIds.has(row.stageId), 'match outside reviewed edition or stage');
    assert(scheduledAt >= Date.parse(scope.windowStart) && scheduledAt < Date.parse(scope.windowEnd) &&
      scheduledAt > Date.parse(edition.fetchedAt), 'match outside reviewed upcoming schedule');
    assert.equal(new Set(row.teamIds).size, row.teamIds.length, 'duplicate opponent');
  }
  const stageIds = new Set(stageChecks.map(stage => stage.stageId));
  assert.equal(stageIds.size, stageChecks.length, 'duplicate stage receipt');
  assert([...stageIds].every(stageId => expectedStageIds.has(stageId)), 'unexpected stage receipt');
  const missingStageIds = [...expectedStageIds].filter(stageId => !stageIds.has(stageId));
  const stages = stageChecks.map(stage => {
    verifyReceipt(stage, upcomingScheduleUrl(editionId, stage.stageId, stage.perPage), stage.matchIds.length);
    return compareStage(stage, rowsByStage.get(stage.stageId) ?? []);
  });
  const scheduledBo3 = countUpcomingFormats(edition.rows)[3] ?? 0;
  const plannedBo3Matches = scope.plannedBo3 === null ? null : scope.plannedBo3 === scheduledBo3;
  const scheduleMatches = missingStageIds.length === 0 && stages.every(stage =>
    stage.membershipMatches && stage.metadataMatches && stage.formatCountsMatch && stage.organizerMatches !== false) &&
    plannedBo3Matches !== false;
  return {editionId, leagueId, observedAt, observedBeforeWindow: Date.parse(observedAt) < Date.parse(windowStart),
    scheduleMatches, scheduledMatches: edition.rows.length, scheduledBo3, organizerPlannedBo3: scope.plannedBo3,
    plannedBo3Matches, missingStageIds, stages,
    providerSnapshotGuaranteed: false, playedBo3: null, observedCoverage: null,
    registrationAllowed: false, outcomeCollectionAllowed: false};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [auditPath, expectedSha, planPath, ...extra] = process.argv.slice(2);
  assert(auditPath && expectedSha && planPath && extra.length === 0,
    'usage: review-series-upcoming-stages.mjs AUDIT.json SHA256 PLAN.json');
  const [bytes, plan, policy] = await Promise.all([
    readFile(auditPath),
    readFile(planPath, 'utf8'),
    readFile(new URL('./series-validation-policy.json', import.meta.url), 'utf8'),
  ]);
  const report = await reviewUpcomingStages(bytes, expectedSha, JSON.parse(plan), JSON.parse(policy));
  console.log(JSON.stringify(report, null, 2));
  if (!report.scheduleMatches) process.exitCode = 1;
}
