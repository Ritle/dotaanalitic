import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { eloLink } from '../../packages/prediction/dist/v1-candidate.js';
import { seriesCandidateProbability } from '../../packages/prediction/dist/series/candidate.js';
import { forecastMetrics } from '../../packages/analytics/dist/forecast-metrics.js';

function measure(rows, probabilityKey, edges) {
  const observations = rows.map(row => ({ probability: row[probabilityKey], teamAWon: row.teamAWon }));
  const { n, correct, accuracyN, ties, accuracy, brier, logLoss } = forecastMetrics(observations);
  let calibrationError = 0;
  const reliability = edges.slice(0, -1).map((lower, index) => {
    const upper = edges[index + 1];
    const group = observations.filter(({ probability }) =>
      probability >= lower && (probability < upper || upper === 1));
    const predicted = group.reduce((sum, row) => sum + row.probability, 0);
    const wins = group.filter(row => row.teamAWon).length;
    calibrationError += Math.abs(predicted - wins);
    return { lower, upper, n: group.length, meanProbability: group.length ? predicted / group.length : null,
      observedWinRate: group.length ? wins / group.length : null };
  });
  return { n, correct, accuracyN, ties, accuracy, brier, logLoss, ece: n ? calibrationError / n : null, reliability };
}

export function evaluateDevelopment(dataset, edges) {
  assert.equal(dataset.format, 'series-development-dataset-v1');
  assert.equal(dataset.purpose, 'development_only');
  assert.equal(dataset.independent, false);
  assert.equal(dataset.deployable, false);
  assert.deepEqual(edges, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  const labels = new Map(dataset.labels.map(label => [label.seriesKey, label]));
  const keys = new Set(dataset.rows.map(row => row.seriesKey));
  assert(labels.size === dataset.labels.length && keys.size === dataset.rows.length &&
    keys.size === labels.size, 'duplicate_or_unmatched_series');
  const scored = [];
  const excluded = [];
  for (const row of dataset.rows) {
    const label = labels.get(row.seriesKey);
    assert(label && typeof label.teamAWon === 'boolean', 'missing_series_outcome');
    assert([1, 3, 5].includes(row.bestOf), 'invalid_format');
    if (row.status === 'unavailable') {
      assert(row.reasons.length > 0 && row.result?.features == null, 'invalid_exclusion');
      excluded.push({ seriesKey: row.seriesKey, bestOf: row.bestOf, reasons: row.reasons });
      continue;
    }
    assert(row.status === 'ready' && row.result.status === 'ready', 'invalid_feature_status');
    assert(row.input.teamAId === label.teamAId && row.input.teamBId === label.teamBId, 'label_orientation');
    const map = eloLink(row.result.features.eloDifference);
    scored.push({ seriesKey: row.seriesKey, bestOf: row.bestOf, teamAWon: label.teamAWon,
      map, series: seriesCandidateProbability(map, row.bestOf), constant: 0.5 });
  }
  function summary(bestOf) {
    const included = scored.filter(row => bestOf === null || row.bestOf === bestOf);
    const denominator = dataset.rows.filter(row => bestOf === null || row.bestOf === bestOf).length;
    return { denominator, scored: included.length, coverage: denominator ? included.length / denominator : null,
      models: Object.fromEntries(['series', 'map', 'constant'].map(key => [key, measure(included, key, edges)])) };
  }
  return { format: 'series-development-evaluation-v1', purpose: 'development_only', syntheticOnly: dataset.syntheticOnly,
    independent: false, deployable: false, qualityGate: 'not_evaluated', pooled: summary(null),
    byFormat: Object.fromEntries([1, 3, 5].map(bestOf => [bestOf, summary(bestOf)])), excluded };
}

// This evaluation uses the exact, previously replayed development artifact.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = new URL('../../', import.meta.url);
  const read = path => readFile(new URL(path, root));
  const evidence = JSON.parse(await read('docs/evidence/s3-09-series-development.json'));
  const bytes = await read(evidence.artifact.path);
  const digest = data => createHash('sha256').update(data).digest('hex');
  assert.equal(digest(bytes), evidence.artifact.sha256, 'development_input_sha');
  const input = JSON.parse(bytes);
  assert.equal(input.format, 'series-development-file-v1');
  assert.equal(input.result.syntheticOnly, false);
  const policy = await read('tools/research/series-validation-policy.json');
  const output = evaluateDevelopment(input.result, JSON.parse(policy).evaluation.bins);
  const report = { input: evidence.artifact, policySha256: digest(policy), result: output };
  const json = JSON.stringify(report, null, 2) + '\n';
  const [file, ...extra] = process.argv.slice(2);
  assert(extra.length === 0);
  if (file) await writeFile(file, json, { flag: 'wx' });
  else process.stdout.write(json);
}
