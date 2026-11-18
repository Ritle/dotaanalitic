"""Frozen conditional research evaluation. No fitting, calibration or activation."""
from __future__ import annotations
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from datetime import datetime
import numpy as np
from scipy.special import expit
from post_draft_fit import environment, load_json, POLICY_PATH

VARIANTS = ('M0', 'M1_raw', 'M1_cal', 'M2_raw', 'M2_cal')
DELTAS = ('logLoss_M2_cal_minus_M1_cal', 'logLoss_M2_cal_minus_M0',
          'brier_M2_cal_minus_M1_cal', 'brier_M2_cal_minus_M0')


def losses(row, variant):
    prediction, label = row['predictions'][variant], int(row['label'])
    z, p = prediction['logit'], prediction['probability']
    return float(np.logaddexp(0, z) - label * z), (p - label) ** 2


def metrics(rows, variant):
    n = len(rows)
    bins = [{'from': i / 10, 'until': (i + 1) / 10, 'upperInclusive': i == 9,
             'n': 0, 'meanProbability': None, 'observedRate': None} for i in range(10)]
    if not n:
        return {'n': 0, 'series': 0, 'logLoss': None, 'brier': None, 'accuracy': None,
                'correct': 0, 'observedRate': None, 'ece': None, 'reliability': bins}
    probabilities = [r['predictions'][variant]['probability'] for r in rows]
    labels = [int(r['label']) for r in rows]
    for i, b in enumerate(bins):
        indices = [j for j, p in enumerate(probabilities) if min(int(p * 10), 9) == i]
        if indices:
            b.update(n=len(indices), meanProbability=sum(probabilities[j] for j in indices) / len(indices),
                     observedRate=sum(labels[j] for j in indices) / len(indices))
    correct = sum((p >= .5) == bool(y) for p, y in zip(probabilities, labels))
    values = np.asarray([losses(r, variant) for r in rows])
    return {'n': n, 'series': len({r['seriesKey'] for r in rows}), 'logLoss': float(values[:, 0].mean()),
            'brier': float(values[:, 1].mean()), 'accuracy': correct / n, 'correct': correct,
            'observedRate': sum(labels) / n,
            'ece': sum(b['n'] / n * abs(b['meanProbability'] - b['observedRate']) for b in bins if b['n']), 'reliability': bins}


def block_draws(series_count, replicates=2000, seed=42):
    return np.random.Generator(np.random.PCG64(seed)).integers(0, series_count, size=(replicates, series_count))


def bootstrap(rows, policy):
    groups = {}
    for row in rows:
        m0, m1, m2 = (losses(row, k) for k in ('M0', 'M1_cal', 'M2_cal'))
        groups.setdefault(row['seriesKey'], []).append([m2[0] - m1[0], m2[0] - m0[0], m2[1] - m1[1], m2[1] - m0[1]])
    base = {'unit': 'whole_series', 'replicates': policy['replicates'], 'seed': policy['seed'],
            'rng': 'numpy.PCG64', 'interval': 'percentile_95_linear', 'series': len(groups), 'maps': len(rows)}
    if not groups:
        return {**base, 'drawSha256': None, 'deltas': {k: {'mean': None, 'lower': None, 'upper': None} for k in DELTAS}}
    blocks = [np.asarray(groups[k]) for k in sorted(groups)]
    sums, sizes = np.asarray([b.sum(axis=0) for b in blocks]), np.asarray([len(b) for b in blocks])
    draws = block_draws(len(blocks), policy['replicates'], policy['seed'])
    sampled = sums[draws].sum(axis=1) / sizes[draws].sum(axis=1)[:, None]
    limits = np.quantile(sampled, [.025, .975], axis=0, method='linear')
    means = sums.sum(axis=0) / sizes.sum()
    return {**base, 'drawSha256': hashlib.sha256(draws.astype('<u4').tobytes()).hexdigest(),
            'deltas': {k: {'mean': float(means[i]), 'lower': float(limits[0, i]), 'upper': float(limits[1, i])} for i, k in enumerate(DELTAS)}}


def validate(data):
    if set(data) != {'format', 'policy', 'rows', 'plannedDenominator', 'upstreamDataChecks', 'parityPassed', 'sourceHashes', 'syntheticOnly'}:
        raise ValueError('input_fields')
    if data['format'] != 'conditional-evaluation-input-v1' or data['policy'] != load_json(POLICY_PATH):
        raise ValueError('policy_changed')
    if type(data['syntheticOnly']) is not bool or data['parityPassed'] is not True:
        raise ValueError('unverified_parity')
    if set(data['sourceHashes']) != {'fitManifest', 'fitArtifact', 'fitResult', 'dataset', 'inventory', 'metadata', 'protocol'}:
        raise ValueError('source_fields')
    upstream = data['upstreamDataChecks']
    if upstream.get('status') not in ('insufficient', 'passed_data_floors_only') or not isinstance(upstream.get('reasons'), list) or any(not isinstance(r, str) for r in upstream['reasons']):
        raise ValueError('upstream_checks')
    if upstream['status'] == 'insufficient' and not upstream['reasons']:
        raise ValueError('upstream_reason_missing')
    if type(data['plannedDenominator']) is not int or not 0 <= data['plannedDenominator'] <= 5000 or len(data['rows']) != data['plannedDenominator']:
        raise ValueError('denominator_changed')
    if any(not isinstance(v, str) or not re.fullmatch('[a-f0-9]{64}', v) for v in data['sourceHashes'].values()):
        raise ValueError('source_hash')
    seen = set()
    window = next(w for w in data['policy']['windows'] if w['name'] == 'development_test')
    for row in data['rows']:
        if set(row) != {'matchId', 'seriesKey', 'startedAt', 'baselineEligible', 'pairedEligible', 'reasons', 'label', 'annotations', 'predictions'}:
            raise ValueError('row_fields')
        if not isinstance(row['matchId'], str) or not re.fullmatch('[1-9][0-9]{0,18}', row['matchId']) or row['matchId'] in seen:
            raise ValueError('duplicate_or_invalid_map')
        seen.add(row['matchId'])
        if not isinstance(row['startedAt'], str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', row['startedAt']) or not window['from'] <= row['startedAt'] < window['until']:
            raise ValueError('wrong_window')
        datetime.fromisoformat(row['startedAt'].replace('Z', '+00:00'))
        if type(row['baselineEligible']) is not bool or type(row['pairedEligible']) is not bool or row['pairedEligible'] and not row['baselineEligible']:
            raise ValueError('eligibility')
        if row['label'] is not None and type(row['label']) is not bool:
            raise ValueError('label')
        if set(row['predictions']) != set(VARIANTS):
            raise ValueError('prediction_fields')
        if row['seriesKey'] is not None and not isinstance(row['seriesKey'], str):
            raise ValueError('series_key')
        if row['baselineEligible'] and (type(row['label']) is not bool or not row['seriesKey'] or row['predictions']['M0'] is None):
            raise ValueError('baseline_missing')
        if not isinstance(row['reasons'], list) or any(not isinstance(r, str) for r in row['reasons']):
            raise ValueError('reasons')
        if not row['baselineEligible'] and not row['reasons']:
            raise ValueError('missing_exclusion_reason')
        if set(row['annotations']) != {'provider', 'leagueId', 'providerPatchId', 'canonicalPatchId', 'monthUTC'}:
            raise ValueError('annotations')
        if row['annotations']['monthUTC'] != row['startedAt'][:7]:
            raise ValueError('month_mismatch')
        if row['annotations']['provider'] not in (None, 'opendota'):
            raise ValueError('provider')
        for key in ('leagueId', 'canonicalPatchId', 'providerPatchId'):
            value = row['annotations'][key]
            if value is not None and not (type(value) is int and value >= 0 or isinstance(value, str) and re.fullmatch('[0-9]+', value)):
                raise ValueError('annotation_id')
        for name, pred in row['predictions'].items():
            if pred is None:
                continue
            if not row['baselineEligible'] or name != 'M0' and not row['pairedEligible']:
                raise ValueError('prediction_outside_cohort')
            if set(pred) != {'logit', 'probability'} or any(type(v) not in (int, float) or not math.isfinite(v) for v in pred.values()):
                raise ValueError('nonfinite_prediction')
            if not 0 <= pred['probability'] <= 1 or abs(float(expit(pred['logit'])) - pred['probability']) >= 1e-12:
                raise ValueError('probability_logit_mismatch')
    return sorted(data['rows'], key=lambda r: int(r['matchId']))


def evaluate(data):
    rows = validate(data)
    baseline = [r for r in rows if r['baselineEligible']]
    paired = [r for r in rows if r['pairedEligible'] and all(r['predictions'][k] is not None for k in VARIANTS)]
    by_model = {k: metrics(paired, k) for k in VARIANTS}
    boot = bootstrap(paired, data['policy']['evaluation']['bootstrap'])
    n, denominator, floors = len(paired), data['plannedDenominator'], data['policy']['sampleFloors']
    coverage = n / denominator if denominator else None
    data_reasons = list(data['upstreamDataChecks']['reasons'])
    if n < floors['developmentTestMaps']:
        data_reasons.append('DEVELOPMENT_TEST_MAPS_BELOW_FLOOR')
    if len({r['seriesKey'] for r in paired}) < floors['developmentTestSeries']:
        data_reasons.append('DEVELOPMENT_TEST_SERIES_BELOW_FLOOR')
    if min(sum(r['label'] for r in paired), sum(not r['label'] for r in paired)) < floors['minEachLabelPerFittedOrScoredBlock']:
        data_reasons.append('DEVELOPMENT_TEST_LABELS_BELOW_FLOOR')
    if (coverage or 0) < .8:
        data_reasons.append('DEVELOPMENT_TEST_COVERAGE_BELOW_0_80')
    if n != sum(r['pairedEligible'] for r in rows):
        data_reasons.append('PAIRED_PREDICTIONS_UNAVAILABLE')
    metric_reasons = []
    if paired:
        m0, m1, m2 = (by_model[k] for k in ('M0', 'M1_cal', 'M2_cal'))
        if boot['deltas'][DELTAS[0]]['upper'] >= 0:
            metric_reasons.append('NO_SIGNIFICANT_LOGLOSS_GAIN_OVER_M1')
        if m2['logLoss'] >= m0['logLoss']:
            metric_reasons.append('LOGLOSS_NOT_BETTER_THAN_M0')
        if m2['brier'] > m0['brier']:
            metric_reasons.append('BRIER_WORSE_THAN_M0')
        if m2['brier'] > m1['brier']:
            metric_reasons.append('BRIER_WORSE_THAN_M1')
        if m2['ece'] > .10:
            metric_reasons.append('M2_ECE_ABOVE_0_10')
    else:
        metric_reasons.append('NO_PAIRED_SCORES')
    data_reasons = sorted(set(data_reasons))
    strata = {}
    for key in ('provider', 'leagueId', 'providerPatchId', 'canonicalPatchId', 'monthUTC'):
        groups = {}
        for row in paired:
            value = row['annotations'][key]
            groups.setdefault('unknown' if value is None else str(value), []).append(row)
        strata[key] = [{'value': value, 'maps': len(group), 'series': len({r['seriesKey'] for r in group}),
                        'metrics': {k: metrics(group, k) for k in VARIANTS}} for value, group in sorted(groups.items())]
    return {'format': 'conditional-post-draft-evaluation-v1', 'scope': 'retrospective_development_previously_exposed_history',
            'counts': {'plannedDenominator': denominator, 'datasetPairedMaps': sum(r['pairedEligible'] for r in rows),
                       'pairedMaps': n, 'pairedSeries': len({r['seriesKey'] for r in paired}), 'baselineMaps': len(baseline),
                       'baselineOnlyMaps': sum(not r['pairedEligible'] for r in baseline), 'coverage': coverage},
            'pairedMetrics': by_model, 'baselineAllMetrics': metrics(baseline, 'M0'),
            'baselineOnlyMetrics': metrics([r for r in baseline if not r['pairedEligible']], 'M0'),
            'bootstrap': boot, 'strata': strata,
            'decision': {'status': 'insufficient' if data_reasons else 'negative' if metric_reasons else 'positive_research_only',
                         'metricSignal': 'unavailable' if not paired else 'negative' if metric_reasons else 'positive',
                         'dataReasons': data_reasons, 'metricReasons': metric_reasons},
            'exclusionReasons': {k: sum(k in r['reasons'] for r in rows) for k in sorted({k for r in rows for k in r['reasons']})},
            'sourceHashes': data['sourceHashes'], 'ledger': rows, 'syntheticOnly': data['syntheticOnly'],
            'trainingPerformed': False, 'releaseGatePassed': False, 'activationAllowed': False, 'deployable': False}


def main():
    if len(sys.argv) != 5 or sys.argv[1] not in ('evaluate', 'verify'):
        raise ValueError('arguments')
    input_path, manifest_path, output_path = map(Path, sys.argv[2:])
    manifest, data = load_json(manifest_path), load_json(input_path)
    if data['syntheticOnly'] is not False or environment() != manifest['pythonEnvironment'] or data['sourceHashes'] != manifest['sourceHashes']:
        raise ValueError('source_environment')
    root = Path(__file__).resolve().parents[2]
    for entry in manifest['code']:
        p = (root / entry['path']).resolve()
        if not p.is_relative_to(root) or hashlib.sha256(p.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError('executable_changed')
    report = evaluate(data)
    report['manifestSha256'] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    report['inputSha256'] = hashlib.sha256(input_path.read_bytes()).hexdigest()
    if sys.argv[1] == 'verify':
        if load_json(output_path) != report:
            raise ValueError('report_replay_mismatch')
    else:
        with output_path.open('x', encoding='utf-8', newline='\n') as handle:
            json.dump(report, handle, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
            handle.write('\n')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Оценка не выполнена. Проверьте manifest, источники, входы и отдельный путь отчёта.', file=sys.stderr)
        sys.exit(1)
