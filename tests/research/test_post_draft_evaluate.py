import copy
import importlib.util
import math
import sys
from pathlib import Path
import numpy as np
import pytest
from sklearn.metrics import brier_score_loss, log_loss, accuracy_score

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/research'))
spec = importlib.util.spec_from_file_location('post_draft_evaluate', ROOT / 'tools/research/post_draft_evaluate.py')
ev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev)


def pred(p):
    return {'probability': p, 'logit': math.log(p / (1 - p))}


def fixture(n=250, excluded=0, bad=False):
    rows = []
    for i in range(n + excluded):
        label = i % 2 == 0
        valid = i < n
        values = {k: None for k in ev.VARIANTS}
        if valid:
            for key, good in [('M0', .55), ('M1_raw', .58), ('M1_cal', .6), ('M2_raw', .8), ('M2_cal', .05 if bad else .95)]:
                values[key] = pred(good if label else 1 - good)
        rows.append({'matchId': str(i + 1), 'seriesKey': 's' + str(i // 2) if valid else None,
                     'startedAt': '2026-09-10T00:00:00.000Z', 'baselineEligible': valid, 'pairedEligible': valid,
                     'reasons': [] if valid else ['INSUFFICIENT_PLAYER_HISTORY'], 'label': label if valid else None,
                     'annotations': {'provider': 'opendota' if valid else None, 'leagueId': '1', 'providerPatchId': 60, 'canonicalPatchId': None, 'monthUTC': '2026-09'},
                     'predictions': values})
    return {'format': 'conditional-evaluation-input-v1', 'policy': ev.load_json(ev.POLICY_PATH), 'rows': rows,
            'plannedDenominator': len(rows), 'upstreamDataChecks': {'status': 'passed_data_floors_only', 'reasons': []},
            'parityPassed': True, 'sourceHashes': {k: 'a' * 64 for k in ['fitManifest', 'fitArtifact', 'fitResult', 'dataset', 'inventory', 'metadata', 'protocol']}, 'syntheticOnly': True}


def test_metrics_agree_with_independent_sklearn_and_manual_reliability():
    rows = fixture(4)['rows']
    ps = [.1, .3, .7, .9]
    for row, p in zip(rows, ps):
        row['predictions']['M0'] = pred(p)
    actual = ev.metrics(rows, 'M0')
    labels = [int(r['label']) for r in rows]
    assert actual['logLoss'] == pytest.approx(log_loss(labels, ps), abs=1e-14)
    assert actual['brier'] == pytest.approx(brier_score_loss(labels, ps), abs=1e-14)
    assert actual['accuracy'] == accuracy_score(labels, np.asarray(ps) >= .5)
    assert actual['ece'] == pytest.approx(sum(abs(p - y) for p, y in zip(ps, labels)) / 4)
    assert sum(b['n'] for b in actual['reliability']) == 4


def test_empty_bins_and_empty_sample_are_null_not_zero_and_endpoints_are_finite():
    empty = ev.metrics([], 'M0')
    assert all(empty[k] is None for k in ['logLoss', 'brier', 'accuracy', 'ece', 'observedRate'])
    assert all(b['observedRate'] is None and b['meanProbability'] is None for b in empty['reliability'])
    data = fixture(2)
    data['rows'][0]['predictions']['M0'] = {'probability': 0, 'logit': -1000}
    data['rows'][1]['predictions']['M0'] = {'probability': 1, 'logit': 1000}
    ev.validate(data)
    result = ev.metrics(data['rows'], 'M0')
    assert result['logLoss'] == 1000 and result['reliability'][0]['n'] == result['reliability'][9]['n'] == 1
    assert ev.evaluate(fixture(0))['decision']['status'] == 'insufficient'


def test_series_bootstrap_uses_entire_unequal_blocks_and_map_weighted_mean(monkeypatch):
    rows = fixture(3)['rows']
    rows[0]['seriesKey'] = rows[1]['seriesKey'] = 'A'
    rows[2]['seriesKey'] = 'B'
    rows[2]['predictions']['M2_cal'] = pred(.01)
    monkeypatch.setattr(ev, 'block_draws', lambda *args: np.array([[0, 0], [1, 1]]))
    delta_a = np.mean([ev.losses(r, 'M2_cal')[0] - ev.losses(r, 'M1_cal')[0] for r in rows[:2]])
    delta_b = ev.losses(rows[2], 'M2_cal')[0] - ev.losses(rows[2], 'M1_cal')[0]
    result = ev.bootstrap(rows, {'replicates': 2, 'seed': 42})['deltas'][ev.DELTAS[0]]
    assert result['mean'] == pytest.approx((2 * delta_a + delta_b) / 3)
    expected = np.quantile([delta_a, delta_b], [.025, .975], method='linear')
    assert [result['lower'], result['upper']] == pytest.approx(expected)


def test_draws_and_report_are_reproducible_and_order_independent():
    data = fixture()
    first = ev.evaluate(data)
    data['rows'].reverse()
    assert ev.evaluate(data) == first
    assert np.array_equal(ev.block_draws(7), ev.block_draws(7))
    assert not np.array_equal(ev.block_draws(7, seed=43), ev.block_draws(7))


def test_positive_diagnostic_never_activates_and_insufficient_coverage_overrides_it():
    good = ev.evaluate(fixture())
    assert good['decision']['status'] == 'positive_research_only'
    assert good['releaseGatePassed'] is False and good['deployable'] is False
    bad_coverage = ev.evaluate(fixture(excluded=100))
    assert bad_coverage['decision']['metricSignal'] == 'positive'
    assert bad_coverage['decision']['status'] == 'insufficient'
    assert bad_coverage['counts']['plannedDenominator'] == 350
    assert 'DEVELOPMENT_TEST_COVERAGE_BELOW_0_80' in bad_coverage['decision']['dataReasons']


def test_negative_metrics_are_retained_without_switching_to_better_raw_model():
    result = ev.evaluate(fixture(bad=True))
    assert result['decision']['status'] == 'negative'
    assert 'NO_SIGNIFICANT_LOGLOSS_GAIN_OVER_M1' in result['decision']['metricReasons']
    assert 'BRIER_WORSE_THAN_M0' in result['decision']['metricReasons']
    assert result['pairedMetrics']['M2_raw']['brier'] < result['pairedMetrics']['M2_cal']['brier']
    assert result['activationAllowed'] is False


def test_same_complete_cohort_and_baseline_only_denominator_are_separate():
    data = fixture()
    row = data['rows'][0]
    row['pairedEligible'] = False
    row['reasons'] = ['HERO_OUTSIDE_TRAIN_VOCABULARY']
    for k in ev.VARIANTS[1:]:
        row['predictions'][k] = None
    result = ev.evaluate(data)
    assert {m['n'] for m in result['pairedMetrics'].values()} == {249}
    assert result['baselineAllMetrics']['n'] == 250 and result['baselineOnlyMetrics']['n'] == 1
    data['rows'][1]['predictions']['M2_cal'] = None
    result = ev.evaluate(data)
    assert 'PAIRED_PREDICTIONS_UNAVAILABLE' in result['decision']['dataReasons']
    assert {m['n'] for m in result['pairedMetrics'].values()} == {248}


def test_unknown_patch_stratum_and_all_small_strata_remain_visible():
    data = fixture()
    data['rows'][0]['annotations']['leagueId'] = '999'
    report = ev.evaluate(data)
    assert report['strata']['canonicalPatchId'][0]['value'] == 'unknown'
    assert report['strata']['canonicalPatchId'][0]['maps'] == 250
    assert any(s['value'] == '999' and s['maps'] == 1 for s in report['strata']['leagueId'])


@pytest.mark.parametrize('kind', ['duplicate', 'window', 'invalid_date', 'denominator', 'nan', 'probability', 'label', 'unknown_reason', 'seed', 'parity'])
def test_invalid_sources_and_numeric_or_policy_changes_fail_closed(kind):
    data = fixture()
    if kind == 'duplicate':
        data['rows'][1]['matchId'] = data['rows'][0]['matchId']
    elif kind == 'window':
        data['rows'][0]['startedAt'] = '2026-05-01T00:00:00.000Z'
    elif kind == 'invalid_date':
        data['rows'][0]['startedAt'] = '2026-09-99T00:00:00.000Z'
    elif kind == 'denominator':
        data['plannedDenominator'] -= 1
    elif kind == 'nan':
        data['rows'][0]['predictions']['M0']['logit'] = float('nan')
    elif kind == 'probability':
        data['rows'][0]['predictions']['M0']['probability'] = .1
    elif kind == 'label':
        data['rows'][0]['label'] = 1
    elif kind == 'unknown_reason':
        data['upstreamDataChecks'] = {'status': 'insufficient', 'reasons': []}
    elif kind == 'seed':
        data['policy']['evaluation']['bootstrap']['seed'] = 99
    elif kind == 'parity':
        data['parityPassed'] = False
    with pytest.raises(ValueError):
        ev.evaluate(data)


def test_upstream_insufficient_is_not_erased_when_current_metrics_pass():
    data = fixture()
    data['upstreamDataChecks'] = {'status': 'insufficient', 'reasons': ['TRAIN_MAPS_BELOW_FLOOR']}
    result = ev.evaluate(data)
    assert result['decision']['status'] == 'insufficient'
    assert 'TRAIN_MAPS_BELOW_FLOOR' in result['decision']['dataReasons']
    assert result['trainingPerformed'] is False
