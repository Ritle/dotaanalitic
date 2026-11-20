import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {collectUpcomingStages} from '../../tools/research/collect-series-upcoming-stages.mjs';
import {sha} from '../../tools/research/exposure-ledger-core.mjs';
import {reviewUpcomingStages} from '../../tools/research/review-series-upcoming-stages.mjs';

const policy = JSON.parse(await readFile(new URL('../../tools/research/series-validation-policy.json', import.meta.url), 'utf8'));
const windowStart = '2026-11-20T00:00:00Z';
const closingTime = '2026-11-20T18:00:00Z';
const scheduledAt = '2026-11-20T11:00:00Z';

function syntheticFixture() {
  const stages = [
    {id: '20', name: 'Synthetic A', from: windowStart, until: closingTime},
    {id: '21', name: 'Synthetic B', from: windowStart, until: closingTime},
  ];
  const catalog = Buffer.from(JSON.stringify({
    format: 'pandascore-edition-metadata-audit-v1',
    results: [{complete: true, pages: [{fetchedAt: '2026-11-19T15:00:00Z'}],
      rows: [{id: '10', leagueId: '9', from: windowStart, until: closingTime, stages}]}],
  }));
  const plan = {format: 'bo3-prospective-scope-plan-v1', editions: [{
    name: 'Synthetic edition', organizerSource: 'https://example.test', windowStart,
    windowEnd: '2026-11-21T00:00:00Z', plannedBo3: 2, binding: {
      editionId: '10', leagueId: '9', stageIds: stages.map(stage => stage.id),
      catalogPath: 'synthetic.json', catalogSha256: sha(catalog),
    },
  }]};
  const firstStage = [100, 101].map(id => ({id, league_id: 9, serie_id: 10, tournament_id: 20,
    videogame: {slug: 'dota-2'}, status: 'not_started', number_of_games: 3, scheduled_at: scheduledAt,
    opponents: [{type: 'Team', opponent: {id: '9007199254740993'}}, {type: 'Team', opponent: {id: 200}}],
    irrelevantProviderField: 'discard this value'}));
  const secondStage = [{...firstStage[0], id: 102, tournament_id: 21, number_of_games: 5, opponents: []}];
  const reads = new Map([
    ['/series/10/matches/upcoming', [...firstStage, ...secondStage]],
    ['/tournaments/20/matches', firstStage],
    ['/tournaments/21/matches', secondStage],
  ]);
  const calls = [], sleeps = [];
  let clock = Date.parse('2026-11-19T16:00:00Z');
  const loadEvidence = async () => catalog;
  const run = (respond = scheduleResponse, token = 'synthetic-secret') => collectUpcomingStages(plan, policy, '10', token, {
    loadEvidence,
    now: () => clock,
    sleep: async ms => {sleeps.push(ms); clock += ms;},
    fetcher: async (url, options) => {
      assert.equal(url.origin, 'https://api.pandascore.co');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-secret');
      assert.equal(url.searchParams.get('filter[status]'), url.pathname.startsWith('/tournaments/') ? 'not_started' : null);
      const rows = reads.get(url.pathname);
      assert(rows, 'unexpected synthetic schedule path');
      calls.push(url.pathname);
      return respond(rows, calls.length);
    },
  });
  return {plan, reads, calls, sleeps, run, loadEvidence};
}

function scheduleResponse(rows, _call, extra = {}) {
  return new Response(JSON.stringify(rows), {headers: {
    'x-page': '1', 'x-per-page': '100', 'x-total': String(rows.length), ...extra,
  }});
}

test('collects exactly one edition and each reviewed stage and replays the saved projection', async () => {
  const fixture = syntheticFixture();
  const {bytes, sha256, review} = await fixture.run();
  assert.equal(sha(bytes), sha256);
  assert.deepEqual(fixture.calls, ['/series/10/matches/upcoming', '/tournaments/20/matches', '/tournaments/21/matches']);
  assert.deepEqual(fixture.sleeps, [4000, 4000]);
  const text = bytes.toString('utf8');
  assert(!text.includes('synthetic-secret'));
  assert(!text.includes('discard this value'));
  assert.deepEqual(JSON.parse(text).edition.rows[0].teamIds, ['200', '9007199254740993']);
  assert.equal(review.scheduleMatches, true);
  assert.equal(review.scheduledBo3, 2);
  assert.equal(review.scheduledMatches, 3);
  assert.equal(review.registrationAllowed, false);
  assert.equal(review.outcomeCollectionAllowed, false);
  assert.deepEqual(await reviewUpcomingStages(bytes, sha256, fixture.plan, policy, fixture.loadEvidence), review);
});

test('keeps missing and replacement IDs in the saved report despite equal counts', async () => {
  const fixture = syntheticFixture();
  fixture.reads.get('/tournaments/20/matches')[0] = {...fixture.reads.get('/tournaments/20/matches')[0], id: 103};
  const {bytes, review} = await fixture.run();
  assert.equal(review.scheduleMatches, false);
  assert.deepEqual(review.stages[0].missing, ['100']);
  assert.deepEqual(review.stages[0].extra, ['103']);
  assert.equal(JSON.parse(bytes).comparedToUnionOfStages.identical, false);
});

test('honors Retry-After and records the original request clock', async () => {
  const fixture = syntheticFixture();
  const {bytes} = await fixture.run((rows, call) => call === 1
    ? new Response('', {status: 429, headers: {'retry-after': '7'}}) : scheduleResponse(rows));
  assert.deepEqual(fixture.sleeps, [7000, 4000, 4000]);
  const receipt = JSON.parse(bytes).edition;
  assert.deepEqual(receipt.attemptStatuses, [429, 200]);
  assert.equal(receipt.requestedAt, '2026-11-19T16:00:00.000Z');
  assert.equal(receipt.fetchedAt, '2026-11-19T16:00:07.000Z');
});

test('stops when a request needs a longer pause, a second retry, or another page', async () => {
  const limited = syntheticFixture();
  await assert.rejects(limited.run(() => new Response('', {status: 429, headers: {'retry-after': '60'}})), /longer pause/u);
  assert.equal(limited.calls.length, 1);
  const offline = syntheticFixture();
  await assert.rejects(offline.run(() => new Response('', {status: 503})), /HTTP 503/u);
  assert.equal(offline.calls.length, 2);
  const partial = syntheticFixture();
  await assert.rejects(partial.run(rows => scheduleResponse(rows, 1, {link: '<https://api.pandascore.co/next>; rel="next"'})), /complete page/u);
  assert.equal(partial.calls.length, 1);
});

test('rejects unreviewed editions before network and unexpected provider rows before stage requests', async () => {
  const unreviewed = syntheticFixture();
  unreviewed.plan.editions[0].binding = null;
  await assert.rejects(unreviewed.run(), /edition scope is not verified/u);
  assert.equal(unreviewed.calls.length, 0);
  const finished = syntheticFixture();
  finished.reads.get('/series/10/matches/upcoming')[0].status = 'finished';
  await assert.rejects(finished.run(), /not a future match/u);
  assert.equal(finished.calls.length, 1);
  const unsafeId = syntheticFixture();
  unsafeId.reads.get('/series/10/matches/upcoming')[0].id = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(unsafeId.run());
  assert.equal(unsafeId.calls.length, 1);
});
