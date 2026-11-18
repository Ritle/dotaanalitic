import copy
import math
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools' / 'research'))
from post_draft_independent_evaluate import evaluate, FEATURE_POLICY


def fixture(n=50):
    rows = []
    for i in range(n):
        label = i % 2 == 0
        def prediction(p):
            p = p if label else 1-p
            return {'logit': math.log(p/(1-p)), 'probability': p}
        rows.append({'matchId': str(i+1), 'seriesKey': 'series:'+str(i//2), 'editionId': '20',
                     'startedAt': '2030-01-10T12:00:00.000Z', 'label': label,
                     'provenance': 'owner_asserted_asof', 'cutoffAt': '2030-01-10T12:01:00.000Z',
                     'persistedAt': '2030-01-10T12:01:01.000Z', 'gameplayStartedAt': '2030-01-10T12:02:00.000Z',
                     'assignmentMatched': True, 'reasons': [],
                     'predictions': {'H0': prediction(.6), 'H1_raw': prediction(.7), 'H1_cal': prediction(.7),
                                     'H2_raw': prediction(.99), 'H2_cal': prediction(.99)}})
    return {'format': 'post-draft-independent-kernel-input-v1', 'syntheticOnly': True,
            'registration': {'registeredAt': '2029-12-30T00:00:00.000Z', 'from': '2030-01-01T00:00:00.000Z',
                             'until': '2030-01-29T00:00:00.000Z', 'assessmentAt': '2030-02-05T00:00:00.000Z',
                             'featurePolicy': FEATURE_POLICY, 'editionIds': ['20']},
            'assessedAt': '2030-02-05T00:00:00.000Z', 'inventoryComplete': True, 'seriesComplete': True,
            'exposedMapIds': [], 'exposedSeriesKeys': [], 'rows': rows}


class IndependentKernelTests(unittest.TestCase):
    def test_complete_synthetic_signal_never_authorizes_real_use(self):
        data = fixture(); before = copy.deepcopy(data); result = evaluate(data)
        self.assertEqual(result['status'], 'positive_synthetic_only')
        self.assertEqual(result['counts']['pairedSeries'], 25)
        self.assertEqual(result['bootstrap']['replicates'], 2000)
        self.assertEqual(result['bootstrap']['rng'], 'numpy.PCG64')
        self.assertFalse(result['deployable']); self.assertFalse(result['independentTestCompleted'])
        self.assertEqual(data, before)

    def test_real_payload_cannot_self_attest_verified_source(self):
        data = fixture(); data['syntheticOnly'] = False
        with self.assertRaisesRegex(ValueError, 'VERIFIED_PROSPECTIVE_BUNDLE_ADAPTER_NOT_IMPLEMENTED'):
            evaluate(data)

    def test_no_metrics_before_terminal_assessment(self):
        data = fixture(); data['assessedAt'] = '2030-02-04T23:59:59.999Z'
        result = evaluate(data)
        self.assertEqual(result['status'], 'not_due'); self.assertIsNone(result['metrics']); self.assertIsNone(result['bootstrap'])

    def test_unknown_universe_and_exhausted_budget_never_assume_coverage(self):
        for flag in ('inventoryComplete', 'seriesComplete'):
            data = fixture(); data[flag] = False
            result = evaluate(data); self.assertIsNone(result['coverage']); self.assertIsNone(result['metrics'])
        result = evaluate(fixture(301)); self.assertIsNone(result['metrics']); self.assertEqual(result['status'], 'insufficient')

    def test_missing_map_input_keeps_denominator_and_excludes_sibling(self):
        data = fixture(); data['rows'][0]['predictions']['H2_cal'] = None
        result = evaluate(data)
        self.assertEqual(result['counts'], {'knownInScopeMaps': 50, 'pairedMaps': 48, 'pairedSeries': 24, 'baselineMaps': 50})
        self.assertEqual(result['coverage'], .96)
        self.assertIn('SERIES_HAS_INELIGIBLE_MAP', result['ledger'][1]['reasons'])
        self.assertIsNone(result['ledger'][0]['predictions']['H2_cal'])

    def test_exposure_map_or_alias_blocks_entire_series(self):
        for key, value in [('exposedMapIds', '1'), ('exposedSeriesKeys', 'series:0')]:
            data = fixture(); data[key] = [value]
            result = evaluate(data); self.assertEqual(result['counts']['pairedMaps'], 48)
            self.assertIn('PREVIOUSLY_EXPOSED', result['ledger'][0]['reasons'])

    def test_boundary_sibling_excludes_in_window_map_without_inflating_denominator(self):
        data = fixture(); data['rows'][0]['startedAt'] = '2029-12-31T23:59:59.999Z'
        result = evaluate(data)
        self.assertEqual(result['counts']['knownInScopeMaps'], 49); self.assertEqual(result['counts']['pairedMaps'], 48)

    def test_unknown_series_label_bindings_and_late_persistence_fail_closed(self):
        for key, value in [('seriesKey', None), ('label', None), ('assignmentMatched', False),
                           ('provenance', None), ('gameplayStartedAt', None),
                           ('persistedAt', '2030-01-10T12:02:00.000Z')]:
            data = fixture(); data['rows'][0][key] = value
            result = evaluate(data); self.assertFalse(result['ledger'][0]['pairedEligible'])
            self.assertEqual(result['status'], 'insufficient')

    def test_exact_cutoff_persistence_is_allowed_but_not_equal_gameplay_start(self):
        data = fixture(); data['rows'][0]['persistedAt'] = data['rows'][0]['cutoffAt']
        self.assertTrue(evaluate(data)['ledger'][0]['pairedEligible'])

    def test_native_microsecond_clocks_are_compared_without_millisecond_rounding(self):
        data = fixture(); row = data['rows'][0]
        row['cutoffAt'] = '2030-01-10T12:01:00.000001Z'
        row['persistedAt'] = '2030-01-10T12:01:00.000002Z'
        row['gameplayStartedAt'] = '2030-01-10T12:01:00.000003Z'
        self.assertTrue(evaluate(data)['ledger'][0]['pairedEligible'])
        row['persistedAt'] = row['gameplayStartedAt']
        self.assertFalse(evaluate(data)['ledger'][0]['pairedEligible'])
        row['persistedAt'] = '2030-01-10T12:01:00.000000Z'
        self.assertFalse(evaluate(data)['ledger'][0]['pairedEligible'])

    def test_duplicate_ids_bad_probability_policy_and_window_are_rejected(self):
        variants = []
        data = fixture(); data['rows'].append(data['rows'][0]); variants.append(data)
        data = fixture(); data['rows'][0]['predictions']['H2_cal']['probability'] = .9; variants.append(data)
        data = fixture(); data['registration']['featurePolicy'] = 'old'; variants.append(data)
        data = fixture(); data['registration']['until'] = '2030-02-01T00:00:00.000Z'; variants.append(data)
        data = fixture(); data['rows'][0]['label'] = 1; variants.append(data)
        for data in variants:
            with self.assertRaises(ValueError): evaluate(data)

    def test_order_invariance_and_shared_series_bootstrap(self):
        data = fixture(); result = evaluate(data); data['rows'].reverse()
        self.assertEqual(evaluate(data), result)

    def test_empty_history_has_null_rates_not_fabricated_probability(self):
        result = evaluate(fixture(0))
        self.assertEqual(result['status'], 'insufficient'); self.assertIsNone(result['coverage'])
        for value in result['metrics'].values(): self.assertIsNone(value['accuracy']); self.assertIsNone(value['logLoss'])

    def test_negative_signal_is_retained(self):
        data = fixture()
        for row in data['rows']: row['predictions']['H2_cal'] = copy.deepcopy(row['predictions']['H1_cal'])
        result = evaluate(data); self.assertEqual(result['status'], 'negative')
        self.assertIn('NO_SIGNIFICANT_GAIN_OVER_H1', result['metricReasons'])


if __name__ == '__main__':
    unittest.main()
