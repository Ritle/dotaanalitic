/** Conditional retrospective diagnostics only. Never a release-gate result. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {forecastMetrics} from '../../packages/analytics/dist/index.js';
import {resolveIdentity} from '../../packages/db/dist/index.js';
import {infer, sigmoid} from '../../apps/api/dist/modules/scenarios/draft-shadow-inference.js';
import {loadShadowCandidate} from '../../apps/api/dist/modules/scenarios/draft-shadow-runtime.js';
import {buildConditionalFutureFeatures} from '../../.tools/s304-future-runtime/conditional-future-holdout.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exactSlots = [0,1,2,3,4,128,129,130,131,132];
const us = milliseconds => (BigInt(milliseconds) * 1000n).toString();
const seriesKey = id => id ? JSON.stringify(['opendota', id]) : null;
const exposurePath = '.tools/s304-series-reconciliation-r1.json';

export function prepareRows(cohort, details, prior, exposure) {
  const byId = new Map(details.collected.map(map => [map.id, map]));
  const missing = new Map(details.missing.map(map => [map.id, map.reason]));
  assert.equal(byId.size + missing.size, cohort.rows.length, 'cohort_denominator_changed');
  const usedMaps = new Set(exposure.mapIds);
  const usedSeries = new Set(exposure.canonicalSeriesKeys);
  for (const map of details.collected) if (map.seriesId && usedMaps.has(map.id)) usedSeries.add(seriesKey(map.seriesId));
  return cohort.rows.map(row => {
    const id = row.match_id, detail = byId.get(id);
    if (!detail) {
      assert(missing.has(id), 'missing_capture_ledger');
      return {id, seriesKey: seriesKey(row.series_id), slotsComplete: false, picksComplete: false, identitiesComplete: false,
        inputs: null, reasons: [missing.get(id)]};
    }
    const key = seriesKey(detail.seriesId), bySlot = [...detail.players].sort((a,b) => a.slot - b.slot);
    const slotsComplete = bySlot.length === 10 && bySlot.every((p,i) => p.slot === exactSlots[i]);
    const picksComplete = slotsComplete && bySlot.every(p => Number.isInteger(p.heroId) && p.heroId > 0)
      && new Set(bySlot.map(p => p.heroId)).size === 10;
    const players = slotsComplete ? bySlot.flatMap(p => {
      if (p.accountId === null || !/^[1-9]\d{0,9}$/.test(p.accountId) || BigInt(p.accountId) >= 4294967295n) return [];
      const verified = resolveIdentity(prior.identities, p.accountId, null);
      return verified.status === 'verified' ? [{...p, playerId: verified.playerId}] : [];
    }) : [];
    const identitiesComplete = players.length === 10 && new Set(players.map(p => p.playerId)).size === 10
      && new Set(players.map(p => p.accountId)).size === 10;
    const reasons = [];
    if (!key) reasons.push('TARGET_SERIES_UNKNOWN');
    if (usedMaps.has(id) || usedSeries.has(key)) reasons.push('KNOWN_PRIOR_EXPOSURE');
    if (!detail.radiantTeamId || !detail.direTeamId || detail.radiantTeamId === detail.direTeamId) reasons.push('TARGET_SIDES_UNKNOWN');
    if (!picksComplete) reasons.push('TARGET_HEROES_INCOMPLETE_OR_DUPLICATE');
    if (!identitiesComplete) reasons.push('TARGET_IDENTITY_UNVERIFIED');
    const base = {id, seriesKey: key, slotsComplete, picksComplete, identitiesComplete};
    if (reasons.length) return {...base, inputs: null, reasons};

    // Team A is the lower verified provider team ID. The model is antisymmetric.
    const result = buildConditionalFutureFeatures({format: 'conditional-future-feature-input-v1',
      target: {matchId: id, seriesKey: key, eventId: cohort.leagueId, startedAtUs: us(detail.startTime * 1000),
        isPro: true, radiantTeamId: detail.radiantTeamId, direTeamId: detail.direTeamId, canonicalPatchId: null,
        sourceSha256: detail.source.payloadSha256, knownAtUs: null, fetchedAtUs: us(Date.parse(detail.source.fetchedAt)), players},
      history: prior.history, heroHistory: prior.heroHistory});
    return {...base, inputs: result.inputs, reasons: result.reasons,
      radiantIsTeamA: BigInt(detail.radiantTeamId) < BigInt(detail.direTeamId),
      featureSha256: result.fingerprint, priorCoverage: result.eloSnapshot?.coverage ?? null,
      historyShortages: result.eloSnapshot ? [...result.eloSnapshot.teamA, ...result.eloSnapshot.teamB]
        .filter(p => p.maps < result.eloSnapshot.policy.minCompletedProMapsPerPlayer)
        .map(p => ({accountId:p.accountId, priorMaps:p.maps, requiredMaps:result.eloSnapshot.policy.minCompletedProMapsPerPlayer})) : []};
  });
}

export function scoreRows(features, labels, model) {
  const byId = new Map(labels.map(label => [label.id, label.radiantWon]));
  const rows = features.filter(row => row.inputs && byId.has(row.id));
  const results = {};
  for (const name of ['H0','H1','H2']) {
    const observations = rows.map(row => ({teamAWon: row.radiantIsTeamA === byId.get(row.id),
      probability: name === 'H0' ? sigmoid(row.inputs.eloLogit) : infer(model.models[name], name, row.inputs).calibratedProbability}));
    const metrics = forecastMetrics(observations);
    const ece = observations.length ? metrics.reliability.reduce((total, bin) => total + (bin.n
      ? bin.n * Math.abs(bin.meanProbability - bin.observedWinRate) / observations.length : 0), 0) : null;
    results[name] = {...metrics, ece};
  }
  const reasons = {};
  for (const row of features) for (const reason of row.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
  return {maps: features.length, matchesWithFullPicks: features.filter(row => row.picksComplete).length,
    matchesWithTenVerifiedAccounts: features.filter(row => row.identitiesComplete).length,
    mapsWithKnownSeries: features.filter(row => row.seriesKey).length,
    observedSeriesIds: new Set(features.map(row => row.seriesKey).filter(Boolean)).size,
    featureReady: features.filter(row => row.inputs).length, pairedMaps: rows.length,
    pairedObservedSeriesIds: new Set(rows.map(row => row.seriesKey)).size,
    pairedCoverage: features.length ? rows.length / features.length : null, exclusionReasons: reasons,
    metrics: results, deltaLogLossH2MinusH1: rows.length ? results.H2.logLoss - results.H1.logLoss : null};
}

async function main() {
  const [mode, directory, ...extra] = process.argv.slice(2);
  assert(['run','verify'].includes(mode) && /^\.tools\/blast-ix-h2-diagnostic-[a-z0-9-]+$/.test(directory ?? '') && !extra.length, 'output_scope');
  const read = async path => {const bytes = await readFile(path); return {data: JSON.parse(bytes), sha256: sha(bytes)};};
  const save = async (name, value) => {
    const file = join(directory, name), bytes = JSON.stringify(value) + '\n';
    if (mode === 'run') await writeFile(file, bytes, {flag: 'wx'});
    else assert.equal(sha(bytes), sha(await readFile(file)), 'replay_difference');
    return sha(bytes);
  };
  const [cohort, details, history, exposure] = await Promise.all(['cohort.json','details.json','history.json']
    .map(name => read(join(directory, name))).concat(read(exposurePath)));
  assert.equal(cohort.data.leagueId, '20208');
  assert.equal(cohort.sha256, history.data.cohortSha256);
  assert.equal(cohort.sha256, details.data.cohortSha256);
  const model = await loadShadowCandidate();
  assert(model, 'frozen_h2_required');
  const rows = prepareRows(cohort.data, details.data, history.data, exposure.data.result.ledger);
  const featuresSha256 = await save('features.json', {cohortSha256: cohort.sha256, historySha256: history.sha256,
    detailsSha256: details.sha256, exposureSha256: exposure.sha256, rows});
  const labels = await read(join(directory, 'outcomes.json'));
  assert.equal(labels.data.cohortSha256, cohort.sha256);
  assert.equal(labels.data.detailsSha256, details.sha256);
  const report = {format: 'blast-ix-h2-retrospective-diagnostic-v1', leagueId: '20208', capturedAt: cohort.data.source.fetchedAt,
    candidateSha256: model.sha256, cohortSha256: cohort.sha256, featuresSha256, labelsSha256: labels.sha256,
    sourceCompleteness: 'opendota_observed_only', outcomeBasis: 'opendota_list_and_detail_agreement',
    independentTest: false, primaryEligible: false, activationAllowed: false, deployable: false, trainingPerformed: false,
    ...scoreRows(rows, labels.data.labels, model)};
  const reportSha256 = await save('report.json', report);
  console.log(JSON.stringify({status: mode === 'verify' ? 'replayed' : 'diagnostic_only', reportSha256, report}, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith('score-blast-ix-h2-diagnostic.mjs')) await main().catch(error => {
  console.error(JSON.stringify({status:'blocked', code: error.code ?? 'diagnostic_validation', reason:error.message.split('\n')[0]}));
  process.exitCode = 1;
});
