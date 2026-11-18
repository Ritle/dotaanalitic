import copy
import sys
from pathlib import Path
import numpy as np
import pytest
from sklearn.metrics import log_loss, brier_score_loss
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools/research'))
import post_draft_r2_evaluate as r2
from test_post_draft_evaluate import fixture, pred


def bundle(n=4):
    previous = fixture(n)
    return {'format': 'post-draft-r2-evaluation-input-v1', 'previous': previous, 'current': copy.deepcopy(previous)}


def test_exact_common_recovered_lost_and_no_cohort_composition_claim():
    data = bundle()
    old = data['previous']['rows'][-1]
    old.update(baselineEligible=False, pairedEligible=False, label=None, reasons=['INSUFFICIENT_PLAYER_HISTORY'],
               predictions={k: None for k in r2.base.VARIANTS})
    result = r2.evaluate(data)
    assert result['common']['mapIds'] == ['1', '2', '3']
    assert result['recovered']['mapIds'] == ['4']
    assert result['lost']['mapIds'] == []
    assert result['overall']['counts']['plannedDenominator'] == 4
    assert result['common']['R1']['M0']['n'] == result['common']['R2']['M0']['n'] == 3
    assert result['common']['deltas']['models']['M0']['logLoss']['mean'] == 0
    assert not result['deployable'] and not result['independentTest']


def test_same_map_metric_deltas_agree_with_independent_sklearn():
    data = bundle()
    for row, p in zip(data['current']['rows'], [.2, .8, .3, .9]):
        for name in r2.base.VARIANTS:
            row['predictions'][name] = pred(p)
    result = r2.evaluate(data)
    y = [r['label'] for r in data['previous']['rows']]
    for name in r2.base.VARIANTS:
        old = [r['predictions'][name]['probability'] for r in data['previous']['rows']]
        new = [r['predictions'][name]['probability'] for r in data['current']['rows']]
        d = result['common']['deltas']['models'][name]
        assert d['logLoss']['mean'] == pytest.approx(log_loss(y, new) - log_loss(y, old), abs=1e-14)
        assert d['brier']['mean'] == pytest.approx(brier_score_loss(y, new) - brier_score_loss(y, old), abs=1e-14)


def test_paired_bootstrap_resamples_whole_unequal_series_with_shared_draws(monkeypatch):
    data = bundle(3)
    for version in ('previous', 'current'):
        data[version]['rows'][0]['seriesKey'] = data[version]['rows'][1]['seriesKey'] = 'A'
        data[version]['rows'][2]['seriesKey'] = 'B'
    data['current']['rows'][2]['predictions']['M0'] = pred(.01)
    monkeypatch.setattr(r2.base, 'block_draws', lambda *args: np.array([[0, 0], [1, 1]]))
    old, new = data['previous']['rows'], data['current']['rows']
    d = r2.paired_revision_deltas(old, new, {'replicates': 2, 'seed': 42})['models']['M0']['logLoss']
    last = r2.base.losses(new[2], 'M0')[0] - r2.base.losses(old[2], 'M0')[0]
    assert d['mean'] == pytest.approx(last / 3)
    assert [d['lower'], d['upper']] == pytest.approx(np.quantile([0, last], [.025, .975], method='linear'))


@pytest.mark.parametrize('mutation', ['label', 'series', 'date', 'missing', 'duplicate'])
def test_reject_changed_targets_and_denominators(mutation):
    data = bundle()
    rows = data['current']['rows']
    if mutation == 'label': rows[0]['label'] = not rows[0]['label']
    elif mutation == 'series': rows[0]['seriesKey'] = 'different'
    elif mutation == 'date': rows[0]['startedAt'] = '2026-09-11T00:00:00.000Z'
    elif mutation == 'missing': rows.pop()
    elif mutation == 'duplicate': rows[1] = copy.deepcopy(rows[0])
    with pytest.raises(ValueError): r2.evaluate(data)


def test_empty_and_unavailable_comparisons_are_null_and_insufficient():
    empty = r2.evaluate(bundle(0))
    assert empty['common']['deltas']['models']['M2_cal']['logLoss']['mean'] is None
    assert empty['overall']['decision']['status'] == 'insufficient'
    data = bundle()
    for row in data['current']['rows']:
        row['predictions']['M2_cal'] = None
        row['reasons'].append('M2_CALIBRATION_UNAVAILABLE')
    result = r2.evaluate(data)
    assert result['common']['mapIds'] == []
    assert result['lost']['mapIds'] == ['1', '2', '3', '4']
    assert 'PAIRED_PREDICTIONS_UNAVAILABLE' in result['overall']['decision']['dataReasons']


def test_replay_is_order_independent_and_does_not_mutate_inputs():
    data = bundle()
    before = copy.deepcopy(data)
    first = r2.evaluate(data)
    assert data == before
    data['current']['rows'].reverse()
    data['previous']['rows'].reverse()
    assert r2.evaluate(data) == first


def test_even_positive_diagnostic_never_passes_release_or_selects_a_revision():
    result = r2.evaluate(bundle(250))
    assert result['overall']['decision']['status'] == 'positive_research_only'
    assert result['releaseGatePassed'] is False
    assert result['activationAllowed'] is False
    assert result['trainingPerformed'] is False
