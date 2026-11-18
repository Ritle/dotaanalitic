import copy
import sys
from pathlib import Path
import pytest
from scipy.special import expit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools/research'))
import post_draft_error_audit as ea
from test_post_draft_evaluate import fixture


def inputs(n=6, excluded=2):
    data = fixture(n, excluded)
    heroes = [{'heroId': i, 'value': 1 if i < 6 else -1} for i in range(1, 11)]
    model = lambda coefs, t: {'status': 'fitted', 'coefficients': coefs, 'intercept': 0,
                              'calibration': {'status': 'fitted', 'temperature': t}}
    artifact = {'deployable': False, 'heroVocabulary': list(range(1, 11)),
                'models': {'M1': model([.8], .8), 'M2': model([.4] + [.02*i for i in range(1, 11)], .5)}}
    rows = []
    for i, row in enumerate(data['rows']):
        valid = row['pairedEligible']
        elo = .3 if i % 2 else -.4
        h = sum(.02*x['heroId']*x['value'] for x in heroes)
        logits = {'M0': elo, 'M1_raw': .8*elo, 'M1_cal': elo, 'M2_raw': .4*elo+h, 'M2_cal': (.4*elo+h)/.5}
        if valid:
            row['predictions'] = {k: {'logit': v, 'probability': float(expit(v))} for k, v in logits.items()}
        if i == n+1:
            row['reasons'] = ['SERIES_HAS_INELIGIBLE_DATASET_MAP']
        rows.append({'matchId': row['matchId'], 'nominalWindow': 'development_test', 'partition': 'development_test',
                     'pairedEligible': valid, 'baselineEligible': valid, 'reasons': row['reasons'],
                     'featureSnapshot': {} if valid else None,
                     'inputs': {'eloLogit': elo, 'signedHeroes': copy.deepcopy(heroes)} if valid else None})
    rows.append({'matchId': '99999', 'nominalWindow': 'train', 'partition': 'train', 'pairedEligible': True,
                 'inputs': {'eloLogit': 0, 'signedHeroes': copy.deepcopy(heroes)}})
    dataset = {'deployable': False, 'rows': rows, 'heroVocabulary': list(range(1, 11))}
    return ea.evaluate(data), dataset, artifact


def test_complete_reconciliation_and_no_mutation():
    args = inputs()
    before = copy.deepcopy(args)
    got = ea.audit(*args)
    assert args == before
    assert got == ea.audit(*args)
    assert got['counts'] == {'planned': 8, 'paired': 6, 'excluded': 2}
    assert len(set(got['lossRanking'])) == 6
    assert sum(g['maps'] for g in got['classification']) == 6
    assert sum(g['maps'] for g in got['bySeries']) == 6
    assert got['siblingOnlyExclusions'] == 1
    assert got['totals']['deltaLogLoss'] == pytest.approx(args[0]['pairedMetrics']['M2_cal']['logLoss'] - args[0]['pairedMetrics']['M1_cal']['logLoss'])
    assert all(h['maps'] == 1 for h in got['heroTrainingExposure'])
    assert got['slopes']['M2CalibratedElo'] == .8
    assert got['slopes']['M1CalibratedElo'] == 1
    for r in got['rows']:
        src = next(x for x in args[0]['ledger'] if x['matchId'] == r['matchId'])
        assert r['m2EloLogit'] + r['m2HeroLogit'] == pytest.approx(src['predictions']['M2_cal']['logit'])
    assert got['activationAllowed'] is False and got['deployable'] is False


def test_side_swap_preserves_errors_and_negates_contributions():
    report, dataset, artifact = inputs()
    before = ea.audit(report, dataset, artifact)
    for row in report['ledger']:
        if row['pairedEligible']:
            row['label'] = not row['label']
            for pred in row['predictions'].values():
                pred['probability'] = 1 - pred['probability']
                pred['logit'] *= -1
    for row in dataset['rows']:
        if row.get('inputs'):
            row['inputs']['eloLogit'] *= -1
            for h in row['inputs']['signedHeroes']:
                h['value'] *= -1
    after = ea.audit(report, dataset, artifact)
    assert after['totals']['deltaLogLoss'] == pytest.approx(before['totals']['deltaLogLoss'])
    for a, b in zip(after['rows'], before['rows']):
        assert a['classification'] == b['classification']
        assert a['m2HeroLogit'] == pytest.approx(-b['m2HeroLogit'])


@pytest.mark.parametrize('mutation', ['duplicate', 'denominator', 'hero', 'logit', 'reasons'])
def test_refuses_broken_bindings(mutation):
    report, dataset, artifact = inputs()
    if mutation == 'duplicate': dataset['rows'].append(copy.deepcopy(dataset['rows'][0]))
    if mutation == 'denominator': report['counts']['plannedDenominator'] += 1
    if mutation == 'hero': dataset['rows'][0]['inputs']['signedHeroes'][0]['heroId'] = 2
    if mutation == 'logit': report['ledger'][0]['predictions']['M2_cal']['logit'] += .01
    if mutation == 'reasons': dataset['rows'][0]['reasons'] = ['invented']
    with pytest.raises(ValueError): ea.audit(report, dataset, artifact)


def test_empty_and_overlap_never_invent_rates_or_independent_counts():
    report, dataset, artifact = inputs(0, 2)
    report['ledger'][0]['reasons'].append('SERIES_HAS_INELIGIBLE_DATASET_MAP')
    dataset['rows'][0]['reasons'] = report['ledger'][0]['reasons']
    result = ea.audit(report, dataset, artifact)
    assert result['totals']['deltaLogLoss'] is None
    assert result['totals']['deltaBrier'] is None
    assert sum(g['maps'] for g in result['exclusionCombinations']) == 2
    assert result['siblingOnlyExclusions'] == 1
    assert result['lossRanking'] == []


def test_strata_include_unknown_and_single_map_groups():
    report, dataset, artifact = inputs()
    report['ledger'][0]['annotations']['leagueId'] = None
    result = ea.audit(report, dataset, artifact)
    assert next(g for g in result['byLeague'] if g['value'] == 'unknown')['maps'] == 1
    assert sum(g['sumDeltaLogLoss'] for g in result['byLeague']) == pytest.approx(result['totals']['sumDeltaLogLoss'])
