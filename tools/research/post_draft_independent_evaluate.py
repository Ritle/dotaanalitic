"""Independent-window numerical kernel. Synthetic harness only until a verified bundle adapter exists.

Does not attest source clocks/labels, register a window, fit models or publish forecasts.
Frozen development evaluators and their manifests remain unchanged.
"""
from __future__ import annotations
from datetime import datetime, timedelta
from pathlib import Path
import copy
import json
import math
import re
from scipy.special import expit
from player_hero_evaluate import metrics, bootstrap, VARIANTS

POLICY = json.loads(Path(__file__).with_name('player-hero-experiment-policy.json').read_text(encoding='utf8'))
FEATURE_POLICY = 'selected-ten-and-known-series-exclusion-v1'


def fields(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected.split()):
        raise ValueError('unexpected_fields')


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:\d{3})?Z', value):
        raise ValueError('timestamp')
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[1-9]\d{0,18}', value) or int(value) > 9223372036854775807:
        raise ValueError('map_identifier')


def evaluate(raw):
    data = copy.deepcopy(raw)
    fields(data, 'format syntheticOnly registration assessedAt inventoryComplete seriesComplete exposedMapIds exposedSeriesKeys rows')
    if data['format'] != 'post-draft-independent-kernel-input-v1':
        raise ValueError('input_format')
    # A caller-supplied flag or SHA is not verification of prospective source evidence.
    if data['syntheticOnly'] is not True:
        raise ValueError('VERIFIED_PROSPECTIVE_BUNDLE_ADAPTER_NOT_IMPLEMENTED')
    r = data['registration']
    fields(r, 'registeredAt from until assessmentAt featurePolicy editionIds')
    registered, start, end, assessment = (timestamp(r[k]) for k in ('registeredAt', 'from', 'until', 'assessmentAt'))
    if not registered < start or end - start != timedelta(days=28) or assessment - end != timedelta(days=7):
        raise ValueError('registration_window')
    if r['featurePolicy'] != FEATURE_POLICY:
        raise ValueError('feature_policy_changed')
    if not isinstance(r['editionIds'], list) or not r['editionIds'] or len(set(r['editionIds'])) != len(r['editionIds']):
        raise ValueError('edition_scope')
    for edition in r['editionIds']:
        identifier(edition)
    for name in ('inventoryComplete', 'seriesComplete'):
        if type(data[name]) is not bool:
            raise ValueError('completeness_flag')
    for key in ('exposedMapIds', 'exposedSeriesKeys'):
        values = data[key]
        if not isinstance(values, list) or any(not isinstance(v, str) or not v for v in values) or len(set(values)) != len(values):
            raise ValueError('exposure_inventory')
    for value in data['exposedMapIds']:
        identifier(value)
    if not isinstance(data['rows'], list) or len(data['rows']) > 1000:
        raise ValueError('inventory_limit')
    seen, groups, ledger = set(), {}, []
    for row in data['rows']:
        fields(row, 'matchId seriesKey editionId startedAt label provenance cutoffAt persistedAt gameplayStartedAt assignmentMatched predictions reasons')
        identifier(row['matchId'])
        if row['matchId'] in seen:
            raise ValueError('duplicate_map')
        seen.add(row['matchId'])
        if row['editionId'] not in r['editionIds']:
            raise ValueError('foreign_edition')
        if row['seriesKey'] is not None and (not isinstance(row['seriesKey'], str) or not row['seriesKey']):
            raise ValueError('series_key')
        event = timestamp(row['startedAt'])
        if row['label'] is not None and type(row['label']) is not bool:
            raise ValueError('label')
        if type(row['assignmentMatched']) is not bool or row['provenance'] not in (None, 'owner_asserted_asof', 'verified_asof'):
            raise ValueError('assignment_or_provenance')
        if not isinstance(row['reasons'], list) or any(not isinstance(v, str) or not v for v in row['reasons']):
            raise ValueError('reasons')
        fields(row['predictions'], ' '.join(VARIANTS))
        for p in row['predictions'].values():
            if p is None:
                continue
            fields(p, 'logit probability')
            if any(type(v) not in (float, int) or not math.isfinite(v) for v in p.values()):
                raise ValueError('nonfinite_prediction')
            if not 0 <= p['probability'] <= 1 or abs(float(expit(p['logit'])) - p['probability']) > 1e-12:
                raise ValueError('probability_mismatch')
        clocks = [None if row[k] is None else timestamp(row[k]) for k in ('cutoffAt', 'persistedAt', 'gameplayStartedAt')]
        why = list(row['reasons'])
        in_window = start <= event < end
        if not in_window:
            why.append('OUTSIDE_WINDOW')
        if row['seriesKey'] is None:
            why.append('SERIES_UNKNOWN')
        if row['matchId'] in data['exposedMapIds'] or row['seriesKey'] in data['exposedSeriesKeys']:
            why.append('PREVIOUSLY_EXPOSED')
        if not all(clocks) or not registered < clocks[0] <= clocks[1] < clocks[2] or clocks[2] < event:
            why.append('PRESTART_PERSISTENCE_NOT_ESTABLISHED')
        if not row['assignmentMatched'] or row['provenance'] is None:
            why.append('ACTUAL_INPUT_BINDING_NOT_ESTABLISHED')
        if row['label'] is None:
            why.append('VERIFIED_LABEL_MISSING')
        baseline = not why and row['predictions']['H0'] is not None
        if any(p is None for p in row['predictions'].values()):
            why.append('PAIRED_PREDICTIONS_MISSING')
        entry = {**row, 'inWindow': in_window, 'baselineEligible': baseline, 'pairedEligible': not why, 'reasons': sorted(set(why))}
        ledger.append(entry)
        if row['seriesKey'] is not None:
            groups.setdefault(row['seriesKey'], []).append(entry)
    # A bad sibling, including one beyond either boundary, excludes the whole series.
    for group in groups.values():
        if len({row['editionId'] for row in group}) > 1:
            raise ValueError('series_edition_conflict')
        if any(not row['pairedEligible'] for row in group):
            for row in group:
                row['pairedEligible'] = False
                row['reasons'] = sorted(set(row['reasons'] + ['SERIES_HAS_INELIGIBLE_MAP']))
    ledger.sort(key=lambda row: int(row['matchId']))
    denominator = sum(row['inWindow'] for row in ledger)
    base = {'format': 'post-draft-independent-kernel-report-v1', 'syntheticOnly': True,
            'featurePolicy': FEATURE_POLICY, 'counts': {'knownInScopeMaps': denominator}, 'ledger': ledger,
            'sourceVerificationPerformed': False, 'independentTestCompleted': False,
            'trainingPerformed': False, 'releaseGatePassed': False, 'activationAllowed': False, 'deployable': False}
    # No performance peeking when the window/grace has not elapsed or the universe is unknown.
    if timestamp(data['assessedAt']) < assessment:
        return {**base, 'status': 'not_due', 'metrics': None, 'bootstrap': None, 'coverage': None}
    if not data['inventoryComplete'] or not data['seriesComplete'] or denominator > 300:
        return {**base, 'status': 'insufficient', 'reasons': ['INVENTORY_INCOMPLETE_OR_BUDGET_EXCEEDED'],
                'metrics': None, 'bootstrap': None, 'coverage': None}
    paired = [row for row in ledger if row['pairedEligible']]
    baseline = [row for row in ledger if row['baselineEligible']]
    n, series = len(paired), len({row['seriesKey'] for row in paired})
    coverage = n / denominator if denominator else None
    floors = POLICY['sampleFloors']
    reasons = []
    if n < floors['developmentTestMaps']:
        reasons.append('MAPS_BELOW_50')
    if series < floors['developmentTestSeries']:
        reasons.append('SERIES_BELOW_25')
    if min(sum(row['label'] for row in paired), sum(not row['label'] for row in paired)) < floors['minEachLabelPerFittedOrScoredBlock']:
        reasons.append('LABELS_BELOW_10_EACH')
    if (coverage or 0) < POLICY['evaluation']['pairedCoverageMinimum']:
        reasons.append('COVERAGE_BELOW_0_80')
    values = {name: metrics(paired, name) for name in VARIANTS}
    boot = bootstrap(paired, POLICY['evaluation']['bootstrap'])
    failures = []
    if paired:
        h0, h1, h2 = (values[k] for k in ('H0', 'H1_cal', 'H2_cal'))
        if boot['deltas']['logLoss_H2_cal_minus_H1_cal']['upper'] >= 0:
            failures.append('NO_SIGNIFICANT_GAIN_OVER_H1')
        if h2['logLoss'] >= h0['logLoss']:
            failures.append('LOGLOSS_NOT_BETTER_THAN_H0')
        if h2['brier'] > min(h0['brier'], h1['brier']):
            failures.append('BRIER_WORSE_THAN_BASELINE')
        if h2['ece'] > .10:
            failures.append('ECE_ABOVE_0_10')
    strata = {provenance: {name: metrics([row for row in paired if row['provenance'] == provenance], name) for name in VARIANTS}
              for provenance in ('owner_asserted_asof', 'verified_asof')}
    return {**base, 'status': 'insufficient' if reasons else 'negative' if failures else 'positive_synthetic_only',
            'counts': {**base['counts'], 'pairedMaps': n, 'pairedSeries': series, 'baselineMaps': len(baseline)},
            'coverage': coverage, 'metrics': values, 'bootstrap': boot, 'dataReasons': reasons, 'metricReasons': failures,
            'provenanceStrata': strata, 'baselineDiagnosticOnly': metrics(baseline, 'H0')}
