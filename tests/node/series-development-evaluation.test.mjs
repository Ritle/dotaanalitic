import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateDevelopment } from '../../tools/research/series-development-evaluation.mjs';

const bins = [0, .2, .4, .6, .8, 1];
function fixture() {
  return { format: 'series-development-dataset-v1', purpose: 'development_only', independent: false, deployable: false, syntheticOnly: true,
    rows: [{ seriesKey: 'a', bestOf: 3, status: 'ready', input: { teamAId: '2', teamBId: '3' },
      result: { status: 'ready', features: { eloDifference: 400 * Math.log10(3) } } },
      { seriesKey: 'b', bestOf: 3, status: 'unavailable', reasons: ['INSUFFICIENT_PLAYER_HISTORY'], result: null }],
    labels: [{ seriesKey: 'b', teamAWon: false }, { seriesKey: 'a', teamAWon: true, teamAId: '2', teamBId: '3' }] };
}

test('pairs the whole-series label by key and retains unavailable series in coverage', () => {
  const report = evaluateDevelopment(fixture(), bins);
  const { models, coverage } = report.byFormat[3];
  assert.equal(coverage, .5);
  const p = 27 / 32; // 2-0 plus either order of 2-1 ending in a win
  assert.equal(models.series.brier, (1 - p) ** 2);
  assert.equal(models.series.logLoss, -Math.log(p));
  assert.equal(models.series.ece, 1 - p);
  assert.equal(models.series.reliability[4].n, 1);
  assert.ok(Math.abs(models.map.brier - .25 ** 2) < 1e-12);
  assert.equal(models.constant.accuracy, null);
  assert.equal(report.byFormat[5].coverage, null);
  assert.equal(report.byFormat[5].models.series.brier, null);
});

test('reversing both sides preserves scores and changes the occupied calibration bin', () => {
  const data = fixture();
  const forward = evaluateDevelopment(data, bins).pooled.models.series;
  data.rows[0].result.features.eloDifference *= -1;
  data.labels[1].teamAWon = false;
  const reverse = evaluateDevelopment(data, bins).pooled.models.series;
  assert.ok(Math.abs(forward.brier - reverse.brier) < 1e-12);
  assert.equal(reverse.reliability[0].n, 1);
});

test('rejects duplicate series, missing labels, mismatched team bindings and non-finite Elo', () => {
  for (const change of [
    d => d.labels.reverse().pop(), d => d.rows.push(d.rows[0]), d => d.labels[0].seriesKey = 'other',
    d => d.labels[1].teamAId = '3', d => d.rows[0].result.features.eloDifference = NaN
  ]) {
    const data = fixture();
    change(data);
    assert.throws(() => evaluateDevelopment(data, bins));
  }
});

test('BO1 keeps map Elo, BO5 uses first-to-three, pooled metrics weight each series once', () => {
  const data = fixture();
  data.rows[0].bestOf = 1;
  const other = structuredClone(data.rows[0]);
  other.seriesKey = 'c';
  other.bestOf = 5;
  data.rows.push(other);
  data.labels.unshift({ ...data.labels[1], seriesKey: 'c', teamAWon: false });
  const r = evaluateDevelopment(data, bins);
  assert.deepEqual(r.byFormat[1].models.series, r.byFormat[1].models.map);
  const p5 = .75 ** 3 * (1 + 3 * .25 + 6 * .25 ** 2);
  assert.ok(Math.abs(r.byFormat[5].models.series.brier - p5 ** 2) < 1e-12);
  assert.ok(Math.abs(r.pooled.models.series.brier - ((.25 ** 2 + p5 ** 2) / 2)) < 1e-12);
  assert.equal(r.byFormat[3].coverage, 0);
  assert.equal(r.byFormat[3].models.series.ece, null);
});
