import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {sha} from '../../tools/research/exposure-ledger-core.mjs';
import {reviewUpcomingStages} from '../../tools/research/review-series-upcoming-stages.mjs';

const root = new URL('../../', import.meta.url);
const cli = fileURLToPath(new URL('tools/research/review-series-upcoming-stages.mjs', root));
const planPath = fileURLToPath(new URL('tools/research/series-bo3-registration-plan.json', root));
const evidencePath = fileURLToPath(new URL('docs/evidence/s3-09-blast-ix-stage-membership-audit.json', root));
const approvedDigest = '3a1107026b6823cd1754a388da251f3e99fac18c827b2f2bc85177e1a15baa19';
const [evidence, plan, policy] = await Promise.all([evidencePath, planPath,
  new URL('tools/research/series-validation-policy.json', root)].map(async path => JSON.parse(await readFile(path, 'utf8'))));

// Changes made in these tests are artificial mutations of the saved schedule.
function reviewMutation(edit) {
  const data = structuredClone(evidence);
  edit(data);
  const bytes = Buffer.from(JSON.stringify(data));
  return reviewUpcomingStages(bytes, sha(bytes), plan, policy);
}

test('ordinary CLI verifies the BLAST edition and stage receipts', () => {
  const result = spawnSync(process.execPath, [cli, evidencePath, approvedDigest, planPath], {encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scheduleMatches, true);
  assert.equal(report.scheduledMatches, 34);
  assert.equal(report.scheduledBo3, 33);
  assert.equal(report.organizerPlannedBo3, 33);
  assert.equal(report.stages.length, 7);
  assert.deepEqual(report.missingStageIds, []);
  assert.equal(report.observedBeforeWindow, true);
  assert.equal(report.providerSnapshotGuaranteed, false);
  assert.equal(report.playedBo3, null);
  assert.equal(report.observedCoverage, null);
  assert.equal(report.registrationAllowed, false);
  assert.equal(report.outcomeCollectionAllowed, false);
});

test('missing stage receipt fails despite an unchanged edition total', async () => {
  const report = await reviewMutation(data => data.stageChecks.pop());
  assert.equal(report.scheduleMatches, false);
  assert.deepEqual(report.missingStageIds, ['22472']);
  assert.equal(report.scheduledMatches, 34);
});

test('missing and extra IDs are detected together when a stage total is unchanged', async () => {
  const original = evidence.stageChecks[0].matchIds[0];
  const replacement = '999999999';
  const report = await reviewMutation(data => {data.stageChecks[0].matchIds[0] = replacement;});
  const stage = report.stages[0];
  assert.deepEqual(stage.missing, [original]);
  assert.deepEqual(stage.extra, [replacement]);
  assert.equal(stage.membershipMatches, false);
  assert.equal(stage.metadataMatches, null);
  assert.equal(report.scheduleMatches, false);
});

test('duplicate match ID and duplicate stage receipt are detected', async () => {
  const report = await reviewMutation(data => {data.stageChecks[0].matchIds[0] = data.stageChecks[0].matchIds[1];});
  assert.equal(report.stages[0].duplicate, true);
  assert.equal(report.scheduleMatches, false);
  await assert.rejects(reviewMutation(data => data.stageChecks.push(data.stageChecks[0])), /duplicate stage receipt/u);
});

test('the stage metadata digest must match even when all IDs are unchanged', async () => {
  const report = await reviewMutation(data => {data.stageChecks[0].normalizedSha256 = 'a'.repeat(64);});
  assert.equal(report.stages[0].membershipMatches, true);
  assert.equal(report.stages[0].metadataMatches, false);
  assert.equal(report.scheduleMatches, false);
});

test('the stage receipt may list the same matches in a different order', async () => {
  const report = await reviewMutation(data => {
    const stage = data.stageChecks[0];
    stage.matchIds.reverse();
    const sorted = stage.matchIds.map(id => data.edition.rows.find(row => row.matchId === id));
    stage.normalizedSha256 = sha(JSON.stringify(sorted));
  });
  assert.equal(report.stages[0].metadataMatches, true);
  assert.equal(report.scheduleMatches, true);
});

test('format differences are reported against stage receipt counts and organizer expectations', async () => {
  const report = await reviewMutation(data => {
    data.stageChecks[0].formatCounts['5'] = 1;
    data.stageChecks[1].organizer.plannedBo3 += 1;
  });
  assert.equal(report.stages[0].formatCountsMatch, false);
  assert.equal(report.stages[1].organizerMatches, false);
  assert.equal(report.scheduleMatches, false);
});

test('unreviewed IDs, partial pages and outcome fields are rejected', async () => {
  await assert.rejects(reviewMutation(data => {
    data.edition.rows[0].stageId = '55555';
    data.edition.normalizedSha256 = sha(JSON.stringify(data.edition.rows));
  }), /outside reviewed edition or stage/u);
  await assert.rejects(reviewMutation(data => {data.stageChecks[0].total += 1;}), /one whole page/u);
  await assert.rejects(reviewMutation(data => {data.edition.rows[0].winnerId = '111';}), /winnerId/u);
});

test('invalid receipt clocks and altered files are rejected', async () => {
  await assert.rejects(reviewMutation(data => {data.stageChecks[0].requestedAt = data.stageChecks[1].fetchedAt;}),
    /receipt precedes its request/u);
  await assert.rejects(reviewUpcomingStages(Buffer.from(JSON.stringify(evidence)), approvedDigest, plan, policy),
    /stage audit digest mismatch/u);
});

test('edition scope must have been documented before the first request', async () => {
  await assert.rejects(reviewMutation(data => {data.edition.requestedAt = '2026-11-19T00:00:00Z';}),
    /edition scope was not verified before collection/u);
});
