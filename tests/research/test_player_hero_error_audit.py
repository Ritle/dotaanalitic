"""Synthetic diagnostic cases only; never training or production predictions."""
import copy
import json
import math
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools/research'))
import player_hero_error_audit as module
import player_hero_evaluate as evaluator


def fixture(n=4, swap=False):
    dataset = {'rows': [], 'deployable': False}
    features = {'rows': [], 'deployable': False}
    artifact = {'models': {}, 'deployable': False}
    for name, coefficients, order in [('H1', [1], ['eloLogit']),
                                     ('H2', [1, 1], ['eloLogit', 'observedHeroPracticeLog90Delta'])]:
        artifact['models'][name] = {'status': 'fitted', 'featureOrder': order, 'coefficients': coefficients,
                                  'intercept': 0, 'calibration': {'status': 'fitted', 'temperature': 1}}
    rows = []
    for i in range(n):
        counts_a, counts_b = ([3]*5, [0]*5) if i < 2 else ([0]*5, [3]*5)
        label, elo = i % 3 == 0, .2
        if swap:
            counts_a, counts_b = counts_b, counts_a
            label, elo = not label, -elo
        a = [{'accountId': str(j), 'nRaw': count, 'log1pCount': math.log1p(count),
              'heroUnknownMaps': 1 if i == 0 and j == 0 else 0} for j, count in enumerate(counts_a)]
        b = [{'accountId': str(j+5), 'nRaw': count, 'log1pCount': math.log1p(count),
              'heroUnknownMaps': 0} for j, count in enumerate(counts_b)]
        am = sum(p['log1pCount'] for p in a)/5
        bm = sum(p['log1pCount'] for p in b)/5
        feature = {'status': 'computed_research_only', 'teamA': a, 'teamB': b, 'teamAMean': am,
                   'teamBMean': bm, 'feature': am-bm, 'deployable': False}
        ps = {}
        for key in evaluator.VARIANTS:
            logit = elo + (am-bm if key.startswith('H2') else 0)
            ps[key] = {'logit': logit, 'probability': 1/(1+math.exp(-logit))}
        row = {'matchId': str(i+1), 'seriesKey': f's{i//2}', 'startedAt': '2026-09-10T00:00:00.000Z',
               'baselineEligible': True, 'pairedEligible': True, 'reasons': [], 'label': label, 'predictions': ps,
               'annotations': {'provider': 'opendota', 'leagueId': '1', 'providerPatchId': 60,
                               'canonicalPatchId': None, 'monthUTC': '2026-09',
                               'hasUnknownHeroHistory': i == 0, 'hasZeroObservedHeroCount': True}}
        rows.append(row)
        dataset['rows'].append({k: row[k] for k in ('matchId', 'seriesKey', 'startedAt', 'baselineEligible', 'pairedEligible')}
                               | {'nominalWindow': 'development_test', 'inputs': {
                                   'eloLogit': elo, 'observedHeroPracticeLog90Delta': am-bm}})
        features['rows'].append({'matchId': row['matchId'], 'seriesKey': row['seriesKey'],
                                 'nominalWindow': 'development_test', 'feature': feature})
    inputs = {'format': 'player-hero-evaluation-input-v1', 'policy': evaluator.load_json(evaluator.POLICY_PATH),
              'rows': rows, 'plannedDenominator': n, 'upstreamDataChecks': {'status': 'passed_data_floors_only', 'reasons': []},
              'parityPassed': True, 'syntheticOnly': True,
              'sourceHashes': {k: 'a'*64 for k in ('plan', 'dataset', 'labels', 'features', 'inventory', 'metadata', 'fitManifest', 'fitArtifact', 'fitResult')}}
    return inputs, dataset, features, artifact


def run(parts):
    inputs, *rest = parts
    return module.audit(evaluator.evaluate(inputs), *rest)


def test_all_transitions_and_independent_losses():
    result = run(fixture())
    assert {r['value']: r['maps'] for r in result['classification']} == {
        'both_correct': 1, 'both_wrong': 1, 'fixed': 1, 'broken': 1}
    for row in result['rows']:
        y = row['label']
        def loss(p):
            return -math.log(p if y else 1-p)
        assert row['deltaLogLoss'] == pytest.approx(loss(row['h2Probability'])-loss(row['h1Probability']), abs=1e-14)
        assert row['deltaBrier'] == pytest.approx((row['h2Probability']-y)**2-(row['h1Probability']-y)**2)
    assert sum(r['maps'] for r in result['bySeries']) == 4
    assert sum(r['sumDeltaLogLoss'] for r in result['bySeries']) == pytest.approx(result['totals']['sumDeltaLogLoss'])
    assert result['originalDecision']['status'] == 'insufficient'
    assert not any(result[k] for k in ('deployable', 'activationAllowed', 'causalAttribution', 'thresholdSelectionPerformed'))


def test_zero_is_observed_count_and_unknown_history_is_separate():
    result = run(fixture())
    assert [r['zeroCountPlayers'] for r in result['rows']] == [5]*4
    assert [r['unknownHistoryPlayers'] for r in result['rows']] == [1, 0, 0, 0]
    zero = result['strata']['hasZeroObservedHeroCount']
    assert zero[0]['maps'] == 0 and zero[0]['deltaLogLoss'] is None
    assert zero[1]['maps'] == 4
    assert sum(r['maps'] for r in result['strata']['hasUnknownHeroHistory']) == 4


def test_empty_null_and_deterministic_no_mutation():
    empty = run(fixture(0))
    assert empty['totals']['deltaLogLoss'] is None and empty['totals']['deltaBrier'] is None
    parts = fixture(); before = copy.deepcopy(parts)
    result = run(parts)
    assert parts == before
    for p in parts[:3]:
        p['rows'].reverse()
    assert run(parts) == result


def test_swapped_sides_preserve_losses_and_transitions():
    original, swapped = run(fixture()), run(fixture(swap=True))
    for a, b in zip(original['rows'], swapped['rows']):
        assert a['classification'] == b['classification']
        assert a['deltaLogLoss'] == pytest.approx(b['deltaLogLoss'])
        assert a['deltaBrier'] == pytest.approx(b['deltaBrier'])
        assert a['h2PracticeLogit'] == -b['h2PracticeLogit']


def test_missing_prediction_retains_whole_series_and_denominator():
    parts = fixture()
    parts[0]['rows'][0]['predictions']['H2_cal'] = None
    result = run(parts)
    assert result['counts'] == {'planned': 4, 'paired': 2, 'excluded': 2}
    assert {r['matchId'] for r in result['excluded']} == {'1', '2'}
    assert all('SERIES_PREDICTION_UNAVAILABLE' in r['auditReasons'] for r in result['excluded'])


def test_temperature_and_elo_slope_are_separate_from_practice():
    parts = fixture()
    parts[3]['models']['H2']['coefficients'] = [.8, .2]
    parts[3]['models']['H2']['calibration']['temperature'] = .9
    for r, d in zip(parts[0]['rows'], parts[1]['rows']):
        raw = .8*d['inputs']['eloLogit']+.2*d['inputs']['observedHeroPracticeLog90Delta']
        for key, logit in [('H2_raw', raw), ('H2_cal', raw/.9)]:
            r['predictions'][key] = {'logit': logit, 'probability': 1/(1+math.exp(-logit))}
    result = run(parts)
    for r, source in zip(result['rows'], parts[0]['rows']):
        expected = source['predictions']['H2_cal']['logit']-source['predictions']['H1_cal']['logit']
        assert r['h2PracticeLogit']+r['eloSlopeChangeLogit'] == pytest.approx(expected)
        assert r['eloSlopeChangeLogit'] != 0


def test_all_zero_history_is_not_excluded_and_tie_selects_a():
    parts = fixture(1)
    r, d, f = parts[0]['rows'][0], parts[1]['rows'][0], parts[2]['rows'][0]['feature']
    for p in f['teamA']+f['teamB']:
        p.update(nRaw=0, log1pCount=0, heroUnknownMaps=0)
    f.update(teamAMean=0, teamBMean=0, feature=0)
    d['inputs'] = {'eloLogit': 0, 'observedHeroPracticeLog90Delta': 0}
    r['annotations']['hasUnknownHeroHistory'] = False
    r['predictions'] = {k: {'logit': 0, 'probability': .5} for k in evaluator.VARIANTS}
    result = run(parts)
    assert result['totals']['unchanged'] == 1
    assert result['rows'][0]['zeroCountPlayers'] == 10
    assert result['rows'][0]['classification'] == 'both_correct'


def test_series_totals_weight_maps_not_equal_series():
    parts = fixture()
    for i in range(3):
        for p in parts[:3]:
            p['rows'][i]['seriesKey'] = 'long'
    result = run(parts)
    assert sorted(r['maps'] for r in result['bySeries']) == [1, 3]
    assert sum(s['deltaLogLoss']*s['maps'] for s in result['bySeries'])/4 == pytest.approx(result['totals']['deltaLogLoss'])


@pytest.mark.parametrize('kind', ['duplicate', 'denominator', 'binding', 'annotation', 'count', 'nan', 'snapshot', 'coefficient', 'calibration', 'deployable', 'target'])
def test_changed_sources_fail_closed(kind):
    inputs, dataset, features, artifact = fixture()
    report = evaluator.evaluate(inputs)
    if kind == 'duplicate': features['rows'].append(copy.deepcopy(features['rows'][0]))
    elif kind == 'denominator': dataset['rows'].pop()
    elif kind == 'binding': dataset['rows'][0]['seriesKey'] = 'changed'
    elif kind == 'annotation': report['ledger'][0]['annotations']['hasUnknownHeroHistory'] = False
    elif kind == 'count': features['rows'][0]['feature']['teamA'][0]['nRaw'] = -1
    elif kind == 'nan': dataset['rows'][0]['inputs']['eloLogit'] = math.nan
    elif kind == 'snapshot': features['rows'][0]['seriesKey'] = 'changed'
    elif kind == 'coefficient': artifact['models']['H2']['coefficients'][1] = 99
    elif kind == 'calibration': artifact['models']['H2']['calibration']['temperature'] = 0
    elif kind == 'deployable': artifact['deployable'] = True
    elif kind == 'target': report['ledger'][0]['label'] = None
    with pytest.raises(ValueError):
        module.audit(report, dataset, features, artifact)


def test_immutable_output_replay_and_tamper(tmp_path):
    path = tmp_path/'audit.json'; result = run(fixture())
    module.write_or_verify(result, path, False)
    module.write_or_verify(result, path, True)
    with pytest.raises(FileExistsError):
        module.write_or_verify(result, path, False)
    tampered = copy.deepcopy(result); tampered['totals']['deltaLogLoss'] = -1
    path.write_text(json.dumps(tampered))
    with pytest.raises(ValueError, match='audit_replay'):
        module.write_or_verify(result, path, True)
