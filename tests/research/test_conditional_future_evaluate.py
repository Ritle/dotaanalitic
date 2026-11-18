import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools' / 'research'))
from conditional_future_evaluate import evaluate, infer_predictions


def fixture(n=50):
    rows, features, labels = [], [], []
    for i in range(n):
        mid, series = str(9007199254740993+i), json.dumps(['opendota', str(i//2+1)], separators=(',', ':'))
        start = '2030-01-10T12:00:00.000Z'
        cutoff = '1894276800000000'
        label = i % 2 == 0
        inputs = {'eloLogit': .2 if label else -.2, 'observedHeroPracticeLog90Delta': 5 if label else -5}
        rows.append({'matchId': mid, 'seriesKey': series, 'eventId': '20', 'startedAt': start,
                     'inDenominator': True, 'possibleTarget': True, 'verifiedLabelAvailable': True, 'pairedEligible': True, 'reasons': []})
        features.append({'matchId': mid, 'seriesKey': series, 'eventId': '20', 'cutoffAtUs': cutoff, 'inputs': inputs,
                         'encoded': {'H0': [inputs['eloLogit']], 'H1': [inputs['eloLogit']], 'H2': list(inputs.values())},
                         'annotations': {'provider': 'opendota', 'leagueId': '20', 'providerPatchId': None, 'canonicalPatchId': None,
                                         'monthUTC': '2030-01', 'hasUnknownHeroHistory': False, 'hasZeroObservedHeroCount': False}})
        labels.append({'matchId': mid, 'seriesKey': series, 'eventId': '20', 'startedAtUs': cutoff,
                       'completedAtUs': str(int(cutoff)+3600000000), 'verifiedAtUs': str(int(cutoff)+7200000000),
                       'teamASide': 'radiant', 'teamAWon': label})
    common = {'syntheticOnly': True, 'evaluationBasis': 'conditional_reconstructed', 'deployable': False}
    return {'bundle': {'cohort': {'format': 'conditional-evaluation-cohort-v1', **common,
                                 'window': {'fromAt': '2030-01-01T00:00:00.000Z', 'until': '2030-01-29T00:00:00.000Z'},
                                 'scope': [{'leagueId': '20', 'editionKey': 'synthetic'}], 'denominatorComplete': True,
                                 'counts': {'knownPossibleMaps': n, 'verifiedProDenominator': n, 'pairedMaps': n, 'pairedSeries': (n+1)//2, 'verifiedLabels': n},
                                 'pairedMapIds': [r['matchId'] for r in rows], 'rows': rows, 'reasons': []},
                       'features': {'format': 'conditional-evaluation-features-v1', **common, 'rows': features},
                       'labels': {'format': 'conditional-evaluation-labels-v1', **common, 'rows': labels}},
            'artifact': {'models': {name: {'status': 'fitted', 'featureOrder': ['eloLogit'] if name == 'H1' else ['eloLogit', 'observedHeroPracticeLog90Delta'],
                                          'coefficients': [1] if name == 'H1' else [1, 1], 'intercept': 0,
                                          'calibration': {'status': 'fitted', 'temperature': 1}} for name in ('H1', 'H2')}},
            'schedule': {'registeredAt': '2029-12-31T00:00:00.000Z', 'from': '2030-01-01T00:00:00.000Z',
                         'until': '2030-01-29T00:00:00.000Z', 'assessmentAt': '2030-02-05T00:00:00.000Z', 'assessedAt': '2030-02-05T00:00:00.000Z'}}


class ConditionalFutureTests(unittest.TestCase):
    def test_positive_synthetic_is_never_activation(self):
        f = fixture(); before = copy.deepcopy(f); r = evaluate(f)
        self.assertEqual(r['status'], 'positive_synthetic_only'); self.assertEqual(r['counts']['pairedMaps'], 50)
        self.assertEqual(r['counts']['pairedSeries'], 25); self.assertEqual(r['bootstrap']['replicates'], 2000)
        self.assertFalse(r['deployable']); self.assertFalse(r['releaseGatePassed']); self.assertEqual(f, before)

    def test_negative_signal_is_retained(self):
        f = fixture(); f['artifact']['models']['H2']['coefficients'] = [1, -1]
        r = evaluate(f); self.assertEqual(r['status'], 'negative'); self.assertTrue(r['metricReasons'])

    def test_not_due_no_inference_even_one_microsecond_early(self):
        f = fixture(); f['schedule']['assessedAt'] = '2030-02-04T23:59:59.999999Z'
        with patch('conditional_future_evaluate.infer_predictions', side_effect=AssertionError('must_not_score')):
            r = evaluate(f)
        self.assertEqual(r['status'], 'not_due'); self.assertIsNone(r['metrics']); self.assertIsNone(r['bootstrap'])

    def test_real_and_unregistered_never_self_authorize(self):
        for real in (True, False):
            f = fixture()
            if real:
                for value in f['bundle'].values(): value['syntheticOnly'] = False
            else: f['schedule']['registeredAt'] = None
            with patch('conditional_future_evaluate.infer_predictions', side_effect=AssertionError('must_not_score')):
                r = evaluate(f)
            self.assertEqual(r['status'], 'unregistered'); self.assertFalse(r['scoringPerformed'])

    def test_unknown_denominator_or_budget_never_yields_metrics(self):
        for f in (fixture(), fixture(301)):
            if len(f['bundle']['cohort']['rows']) == 50: f['bundle']['cohort']['denominatorComplete'] = False
            r = evaluate(f); self.assertEqual(r['status'], 'insufficient'); self.assertIsNone(r['coverage']); self.assertIsNone(r['metrics'])

    def test_zero_sample_null_not_zero_rates(self):
        r = evaluate(fixture(0)); self.assertEqual(r['status'], 'insufficient'); self.assertIsNone(r['coverage'])
        self.assertIsNone(r['metrics']['H0']['accuracy']); self.assertIsNone(r['metrics']['H2_cal']['logLoss'])

    def test_floors_and_labels_are_not_lowered(self):
        r = evaluate(fixture(48)); self.assertIn('MAPS_BELOW_50', r['dataReasons']); self.assertIn('SERIES_BELOW_25', r['dataReasons'])
        f = fixture()
        for row in f['bundle']['labels']['rows']: row['teamAWon'] = True
        self.assertIn('LABELS_BELOW_10_EACH', evaluate(f)['dataReasons'])

    def test_missing_calibrator_no_raw_fallback(self):
        f = fixture(); f['artifact']['models']['H2']['calibration'] = {'status': 'insufficient', 'temperature': None}
        r = evaluate(f); self.assertEqual(r['status'], 'insufficient'); self.assertEqual(r['counts']['pairedMaps'], 0)
        self.assertEqual(r['counts']['baselineMaps'], 50); self.assertEqual(r['counts']['verifiedProDenominator'], 50)
        self.assertIn('PAIRED_PREDICTIONS_UNAVAILABLE', r['dataReasons'])

    def test_excluded_map_keeps_denominator_and_excludes_sibling(self):
        f = fixture(); c = f['bundle']['cohort']; mid = c['rows'][0]['matchId']
        c['rows'][0]['pairedEligible'] = False; c['rows'][0]['reasons'] = ['MISSING_INPUT']; c['pairedMapIds'].remove(mid); c['counts']['pairedMaps'] -= 1
        for key in ('features', 'labels'): f['bundle'][key]['rows'] = [r for r in f['bundle'][key]['rows'] if r['matchId'] != mid]
        r = evaluate(f); self.assertEqual(r['counts']['verifiedProDenominator'], 50); self.assertEqual(r['counts']['pairedMaps'], 48); self.assertEqual(r['coverage'], .96)

    def test_binding_count_duplicate_and_feature_tampering_rejected(self):
        changes = [lambda f: f['bundle']['labels']['rows'].pop(),
                   lambda f: f['bundle']['features']['rows'].append(f['bundle']['features']['rows'][0]),
                   lambda f: f['bundle']['cohort']['counts'].update(verifiedProDenominator=1),
                   lambda f: f['bundle']['labels']['rows'][0].update(seriesKey='wrong'),
                   lambda f: f['bundle']['features']['rows'][0]['encoded'].update(H2=[0, 0]),
                   lambda f: f['bundle']['features']['rows'][0]['inputs'].update(eloLogit=float('nan')),
                   lambda f: f['bundle']['labels']['rows'][0].update(completedAtUs='1'),
                   lambda f: f['bundle']['labels']['rows'][0].update(teamAWon=1)]
        for change in changes:
            f = fixture(); change(f)
            with self.assertRaises(ValueError): evaluate(f)

    def test_window_change_late_registration_and_grace_rejected(self):
        for name, value in [('from', '2030-01-02T00:00:00.000Z'), ('registeredAt', '2030-01-01T00:00:00.000Z'),
                            ('assessmentAt', '2030-02-04T00:00:00.000Z')]:
            f = fixture(); f['schedule'][name] = value
            with self.assertRaises(ValueError): evaluate(f)

    def test_frozen_numerical_functions_and_bootstrap_are_reused(self):
        from player_hero_evaluate import metrics, bootstrap
        r = evaluate(fixture()); paired = [row for row in r['ledger'] if row['pairedEligible']]
        self.assertEqual(r['metrics']['H2_cal'], metrics(paired, 'H2_cal'))
        from conditional_future_evaluate import POLICY
        self.assertEqual(r['bootstrap'], bootstrap(paired, POLICY['evaluation']['criteria']['bootstrap']))
        self.assertEqual(r, evaluate(fixture()))

    def test_extreme_finite_logits_and_invalid_temperature(self):
        f = fixture(); scores = infer_predictions(f['artifact'], {'eloLogit': 1000, 'observedHeroPracticeLog90Delta': -1000})
        self.assertEqual(scores['H0']['probability'], 1)
        f['artifact']['models']['H1']['calibration']['temperature'] = .25
        with self.assertRaises(ValueError): infer_predictions(f['artifact'], {'eloLogit': 0, 'observedHeroPracticeLog90Delta': 0})

    def test_noncanonical_series_cannot_inflate_bootstrap_units(self):
        f = fixture()
        for key in ('cohort', 'features', 'labels'):
            f['bundle'][key]['rows'][0]['seriesKey'] = '["opendota", "1"]'
        f['bundle']['cohort']['counts']['pairedSeries'] = 26
        with self.assertRaisesRegex(ValueError, 'native_series'):
            evaluate(f)


if __name__ == '__main__': unittest.main()
