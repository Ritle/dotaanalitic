import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL('../../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const evidence = JSON.parse(await read('docs/evidence/s3-04-dl30-window-review.json'));
const proposalBytes = await read(evidence.proposal);
const proposal = JSON.parse(proposalBytes);
const parentBytes = await read(proposal.parent.path);
const parent = JSON.parse(parentBytes);

test('the separate Swiss proposal keeps the frozen comparisons and seven days for outcomes', async () => {
  const swiss = JSON.parse(await read('tools/research/player-hero-dl30-swiss-proposal.json'));
  assert.equal(swiss.alternativeTo.sha256, sha(await read(swiss.alternativeTo.path)));
  assert.equal(swiss.alternativeTo.sha256, sha(proposalBytes));
  assert.equal(swiss.parent.sha256, sha(await read(swiss.parent.path)));
  assert.equal(swiss.parent.sha256, sha(parentBytes));
  assert.deepEqual(swiss.parent.overrides, ['proposedRegistration', 'evaluation.durationDays']);
  assert.deepEqual(swiss.scope.rounds, [1, 2, 3, 4, 5, 6]);
  assert.equal(swiss.scope.stage, 'Swiss Stage');
  assert.equal(swiss.scope.bestOf, 3);
  assert(swiss.scope.excludedStages.includes('playoffs'));
  assert(swiss.scope.excludedLeagueIds.includes('20359'));
  const {decisionDeadline, fromInclusive, untilExclusive, assessmentAt} = swiss.window;
  assert.equal(decisionDeadline, proposal.scope.decisionDeadline);
  assert(decisionDeadline < fromInclusive && fromInclusive.slice(0, 10) <= swiss.scope.fromDate);
  assert(swiss.scope.throughDate < untilExclusive.slice(0, 10));
  assert.equal(Date.parse(assessmentAt) - Date.parse(untilExclusive), parent.evaluation.outcomeGraceDays * 86_400_000);
  assert.equal(assessmentAt, '2026-12-16T00:00:00.000Z');
  assert.equal(swiss.registeredAt, null);
  assert.deepEqual([swiss.collectionAllowed, swiss.evaluationAllowed, swiss.activationAllowed], [false, false, false]);
});

test('new dates inherit the frozen map criteria and exclude the qualifier and January edition', () => {
  assert.equal(sha(proposalBytes), evidence.db.proposalSha256);
  assert.equal(sha(parentBytes), proposal.parent.sha256);
  assert.equal(parent.candidate.artifactSha256, evidence.db.candidateSha256);
  for (const key of proposal.parent.inheritExactly) {
    assert(Object.hasOwn(parent, key));
    assert(!Object.hasOwn(proposal, key));
  }
  const s = proposal.scope;
  const day = 86_400_000;
  assert.equal(Date.parse(s.untilExclusive) - Date.parse(s.fromInclusive), parent.evaluation.durationDays * day);
  assert.equal(Date.parse(s.assessmentAt) - Date.parse(s.untilExclusive), parent.evaluation.outcomeGraceDays * day);
  assert(evidence.db.checkedAt < s.decisionDeadline && s.decisionDeadline < s.fromInclusive);
  assert.deepEqual(s.events.map(x => [x.name, x.stage]), [['DreamLeague Season 30', 'main_event']]);
  assert.deepEqual(s.events[0].excludedOpenDotaQualifierIds, ['20359']);
  assert(s.fromInclusive.slice(0, 10) <= s.events[0].fromDate && s.events[0].throughDate < s.untilExclusive.slice(0, 10));
  assert(proposal.separatelyConsidered.every(x => !x.included && !s.events.some(e => e.name === x.name)));
});

test('size estimates and partial exposure review do not authorize enrollment', async () => {
  const {planningCapacity: c, db} = evidence;
  assert.equal(c.plannedSeries, c.teams * c.bo3PerTeam / 2);
  assert.deepEqual(c.possiblePlayedMapsIfAllCompleted, [c.plannedSeries * 2, c.plannedSeries * 3]);
  assert.deepEqual(c.coverageFloorAtEndpoints,
    c.possiblePlayedMapsIfAllCompleted.map(n => Math.ceil(n * parent.evaluation.criteria.pairedCoverageMinimum)));
  assert.equal(c.actualDenominator, null);
  assert.equal(sha(await read(evidence.scheduleEvidence.capacityReport.path)), evidence.scheduleEvidence.capacityReport.sha256);
  assert.equal(sha(await read(evidence.historicalLedgerSummary.source)), evidence.historicalLedgerSummary.sha256);
  assert.equal(db.requiredLedgerSha256, parent.independence.exposure.sha256);
  assert.equal(db.developmentIdsFound, db.developmentMapIds);
  assert.equal(db.developmentSeriesIdsFound, db.developmentSeriesIds);
  assert.equal(db.developmentStartsInWindow, 0);
  assert.equal(db.targetMembershipCompared, false);
  assert.equal(db.independenceEstablished, false);
  assert.equal(proposal.registeredAt, null);
  for (const allowed of [proposal.collectionAllowed, proposal.evaluationAllowed, proposal.activationAllowed, evidence.registrationReady]) {
    assert.equal(allowed, false);
  }
});
