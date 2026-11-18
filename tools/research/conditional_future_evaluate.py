"""Conditional B numerical consumer. Synthetic execution only until durable registration is implemented."""
from __future__ import annotations
import copy
import json
import math
import re
import sys
from datetime import timedelta
from pathlib import Path
from scipy.special import expit
from player_hero_fit import vector, ORDER
from player_hero_evaluate import metrics, bootstrap, VARIANTS, ANNOTATIONS
from post_draft_independent_evaluate import timestamp
from post_draft_fit import load_json, micros, environment

POLICY = load_json(Path(__file__).with_name('player-hero-conditional-future-policy.json'))


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def index(rows):
    require(isinstance(rows, list) and len(rows) <= 5000, 'row_limit')
    result = {}
    for row in rows:
        mid = row.get('matchId')
        require(isinstance(mid, str) and re.fullmatch(r'[1-9]\d{0,18}', mid) and int(mid) <= 9223372036854775807 and mid not in result, 'duplicate_or_invalid_map')
        result[mid] = row
    return result


def infer_predictions(artifact, inputs):
    values = vector(inputs)
    predictions = {name: None for name in VARIANTS}
    predictions['H0'] = {'logit': values[0], 'probability': float(expit(values[0]))}
    for name, size in [('H1', 1), ('H2', 2)]:
        model = artifact['models'][name]
        if model['status'] == 'unavailable':
            continue
        require(model['status'] == 'fitted' and model['intercept'] == 0 and model['featureOrder'] == ORDER[:size], 'model_contract')
        coefficients = model['coefficients']
        require(len(coefficients) == size and all(type(c) in (int, float) and math.isfinite(c) for c in coefficients), 'model_coefficients')
        logit = sum(x*c for x, c in zip(values[:size], coefficients))
        require(math.isfinite(logit), 'nonfinite_logit')
        predictions[name+'_raw'] = {'logit': logit, 'probability': float(expit(logit))}
        calibration = model['calibration']
        require(calibration['status'] in ('fitted', 'insufficient'), 'calibrator_status')
        if calibration['status'] == 'fitted':
            temperature = calibration['temperature']
            require(type(temperature) in (float, int) and math.isfinite(temperature) and .25+1e-6 < temperature < 4-1e-6, 'temperature')
            calibrated = logit / temperature
            require(math.isfinite(calibrated), 'nonfinite_calibrated_logit')
            predictions[name+'_cal'] = {'logit': calibrated, 'probability': float(expit(calibrated))}
    return predictions


def validate_bundle(bundle):
    require(set(bundle) == {'cohort', 'features', 'labels'}, 'bundle_fields')
    c, f, l = (bundle[k] for k in ('cohort', 'features', 'labels'))
    for name, obj in [('cohort', c), ('features', f), ('labels', l)]:
        require(obj['format'] == 'conditional-evaluation-'+name+'-v1' and type(obj['syntheticOnly']) is bool, 'bundle_format')
        require(obj['syntheticOnly'] == c['syntheticOnly'] and obj['evaluationBasis'] == 'conditional_reconstructed' and obj['deployable'] is False, 'bundle_basis')
    rows, features, labels = index(c['rows']), index(f['rows']), index(l['rows'])
    paired = {mid for mid, r in rows.items() if r['pairedEligible']}
    require(len(c['pairedMapIds']) == len(paired) and set(c['pairedMapIds']) == paired == set(features) == set(labels), 'paired_ids_changed')
    require(type(c['denominatorComplete']) is bool, 'completeness')
    start, end = timestamp(c['window']['fromAt']), timestamp(c['window']['until'])
    require(start < end, 'window')
    editions = {s['leagueId'] for s in c['scope']}
    require(editions and len(editions) == len(c['scope']), 'scope')
    for mid, row in rows.items():
        require(all(type(row[k]) is bool for k in ('pairedEligible', 'inDenominator', 'possibleTarget')), 'row_flags')
        require(isinstance(row['reasons'], list) and all(isinstance(r, str) for r in row['reasons']), 'row_reasons')
        if row['inDenominator']:
            require(row['possibleTarget'] and row['eventId'] in editions and start <= timestamp(row['startedAt']) < end, 'denominator_scope')
        if mid not in paired:
            continue
        require(row['inDenominator'] and not row['reasons'], 'paired_eligibility')
        series = row['seriesKey']
        try:
            identity = json.loads(series)
        except (ValueError, TypeError):
            raise ValueError('native_series')
        require(isinstance(identity, list) and len(identity) == 2 and identity[0] == 'opendota' and
                isinstance(identity[1], str) and re.fullmatch('[1-9][0-9]{0,18}', identity[1]) and int(identity[1]) <= 9223372036854775807 and
                json.dumps(identity, separators=(',', ':')) == series, 'native_series')
        feature, label = features[mid], labels[mid]
        require(feature['seriesKey'] == label['seriesKey'] == series and feature['eventId'] == label['eventId'] == row['eventId'], 'source_binding')
        cutoff = str(micros(row['startedAt']))
        require(feature['cutoffAtUs'] == label['startedAtUs'] == cutoff, 'cutoff_binding')
        require(int(cutoff) < int(label['completedAtUs']) <= int(label['verifiedAtUs']) and label['teamASide'] in ('radiant', 'dire'), 'label_clock_or_side')
        require(type(label['teamAWon']) is bool, 'label_type')
        values = vector(feature['inputs'])
        require(feature['encoded'] == {'H0': values[:1], 'H1': values[:1], 'H2': values}, 'feature_order')
        annotations = feature['annotations']
        require(set(annotations) == set(ANNOTATIONS) and annotations['provider'] == 'opendota' and
                annotations['leagueId'] == row['eventId'] and annotations['monthUTC'] == row['startedAt'][:7], 'annotation_binding')
        for key in ('hasUnknownHeroHistory', 'hasZeroObservedHeroCount'):
            require(type(annotations[key]) is bool, 'missingness_annotation')
    denominator = sum(r['inDenominator'] for r in rows.values())
    possible = sum(r['possibleTarget'] for r in rows.values())
    require(c['counts']['verifiedProDenominator'] == denominator and c['counts']['knownPossibleMaps'] == possible and
            c['counts']['pairedMaps'] == len(paired) and c['counts']['pairedSeries'] == len({rows[mid]['seriesKey'] for mid in paired}), 'count_mismatch')
    return c, rows, features, labels


def evaluate(raw):
    data = copy.deepcopy(raw)
    require(set(data) == {'bundle', 'artifact', 'schedule'}, 'input_fields')
    c, source_rows, features, labels = validate_bundle(data['bundle'])
    counts = {'knownPossibleMaps': c['counts']['knownPossibleMaps'], 'verifiedProDenominator': c['counts']['verifiedProDenominator']}
    base = {'format': 'conditional-future-evaluation-report-v1', 'syntheticOnly': c['syntheticOnly'], 'basis': 'conditional_reconstructed',
            'counts': counts, 'sourceLedger': c['rows'], 'independentTestCompleted': False, 'trainingPerformed': False,
            'calibrationFittingPerformed': False, 'releaseGatePassed': False, 'activationAllowed': False, 'deployable': False}
    def blocked(status, reasons):
        return {**base, 'status': status, 'reasons': reasons, 'scoringPerformed': False, 'metrics': None, 'bootstrap': None, 'coverage': None, 'ledger': []}
    # No caller-supplied timestamp or boolean grants real assessment permission.
    if c['syntheticOnly'] is not True:
        return blocked('unregistered', ['DURABLE_CONDITIONAL_REGISTRATION_NOT_IMPLEMENTED'])
    schedule = data['schedule']
    require(isinstance(schedule, dict) and set(schedule) == {'registeredAt', 'from', 'until', 'assessmentAt', 'assessedAt'}, 'schedule_fields')
    if schedule['registeredAt'] is None:
        return blocked('unregistered', ['REGISTRATION_MISSING'])
    registered, start, end, assessment, now = (timestamp(schedule[k]) for k in ('registeredAt', 'from', 'until', 'assessmentAt', 'assessedAt'))
    require(registered < start and end-start == timedelta(days=POLICY['evaluation']['durationDays']) and
            assessment-end == timedelta(days=POLICY['evaluation']['outcomeGraceDays']), 'registered_window')
    require(start == timestamp(c['window']['fromAt']) and end == timestamp(c['window']['until']), 'registered_scope_window')
    if now < assessment:
        return blocked('not_due', ['ASSESSMENT_NOT_DUE'])
    if not c['denominatorComplete'] or counts['knownPossibleMaps'] > POLICY['budget']['maxTargetMaps'] or c['reasons']:
        return blocked('insufficient', ['INVENTORY_INCOMPLETE_OR_BUDGET_EXCEEDED'])
    ledger = []
    for mid, row in sorted(source_rows.items(), key=lambda p: int(p[0])):
        predictions = {name: None for name in VARIANTS}
        reasons = list(row['reasons'])
        label, annotations = None, None
        if mid in features:
            predictions = infer_predictions(data['artifact'], features[mid]['inputs'])
            label, annotations = labels[mid]['teamAWon'], features[mid]['annotations']
            if any(value is None for value in predictions.values()):
                reasons.append('PAIRED_PREDICTIONS_UNAVAILABLE')
        else:
            reasons.append('PAIRED_INPUT_UNAVAILABLE')
        ledger.append({**row, 'pairedEligible': row['pairedEligible'] and not reasons, 'reasons': sorted(set(reasons)),
                       'predictions': predictions, 'label': label, 'annotations': annotations})
    bad = {r['seriesKey'] for r in ledger if not r['pairedEligible'] and r['seriesKey'] is not None}
    for row in ledger:
        if row['seriesKey'] in bad:
            row['pairedEligible'] = False
            row['reasons'] = sorted(set(row['reasons']+['SERIES_HAS_UNAVAILABLE_MEMBER']))
    paired = [r for r in ledger if r['pairedEligible']]
    baseline = [r for r in ledger if r['predictions']['H0'] is not None]
    n, series, denominator = len(paired), len({r['seriesKey'] for r in paired}), counts['verifiedProDenominator']
    coverage = n/denominator if denominator else None
    floors, criteria = POLICY['evaluation']['sampleFloors'], POLICY['evaluation']['criteria']
    reasons = []
    if n < floors['developmentTestMaps']: reasons.append('MAPS_BELOW_50')
    if series < floors['developmentTestSeries']: reasons.append('SERIES_BELOW_25')
    if min(sum(r['label'] for r in paired), sum(not r['label'] for r in paired)) < floors['minEachLabelPerFittedOrScoredBlock']: reasons.append('LABELS_BELOW_10_EACH')
    if (coverage or 0) < criteria['pairedCoverageMinimum']: reasons.append('COVERAGE_BELOW_0_80')
    if any('PAIRED_PREDICTIONS_UNAVAILABLE' in r['reasons'] for r in ledger): reasons.append('PAIRED_PREDICTIONS_UNAVAILABLE')
    values, boot = {name: metrics(paired, name) for name in VARIANTS}, bootstrap(paired, criteria['bootstrap'])
    failures = []
    if paired:
        h0, h1, h2 = (values[name] for name in ('H0', 'H1_cal', 'H2_cal'))
        if boot['deltas']['logLoss_H2_cal_minus_H1_cal']['upper'] >= 0: failures.append('NO_SIGNIFICANT_LOGLOSS_GAIN_OVER_H1')
        if h2['logLoss'] >= h0['logLoss']: failures.append('LOGLOSS_NOT_BETTER_THAN_H0')
        if h2['brier'] > h0['brier']: failures.append('BRIER_WORSE_THAN_H0')
        if h2['brier'] > h1['brier']: failures.append('BRIER_WORSE_THAN_H1')
        if h2['ece'] > .10: failures.append('H2_ECE_ABOVE_0_10')
    strata = {}
    for key in ANNOTATIONS:
        groups = {'false': [], 'true': []} if key.startswith('has') else {}
        for row in paired:
            value = row['annotations'][key]
            value = 'unknown' if value is None else str(value).lower() if type(value) is bool else str(value)
            groups.setdefault(value, []).append(row)
        strata[key] = [{'value': value, 'maps': len(group), 'series': len({r['seriesKey'] for r in group}),
                        'metrics': {name: metrics(group, name) for name in VARIANTS}} for value, group in sorted(groups.items())]
    return {**base, 'status': 'insufficient' if reasons else 'negative' if failures else 'positive_synthetic_only',
            'scoringPerformed': bool(features), 'counts': {**counts, 'pairedMaps': n, 'pairedSeries': series, 'baselineMaps': len(baseline)},
            'coverage': coverage, 'pairedMapIds': [r['matchId'] for r in paired], 'metrics': values, 'bootstrap': boot,
            'dataReasons': reasons, 'metricReasons': failures, 'strata': strata, 'ledger': ledger,
            'baselineDiagnosticOnly': metrics(baseline, 'H0'), 'baselineBasis': 'available_prepared_bundle_features_only'}


def main():
    require(len(sys.argv) in (2, 3), 'arguments')
    if sys.argv[1] == 'environment' and len(sys.argv) == 2:
        result = environment()
    elif sys.argv[1] == 'evaluate' and len(sys.argv) == 3:
        result = evaluate(load_json(sys.argv[2]))
    elif sys.argv[1] == 'infer' and len(sys.argv) == 3:
        data = load_json(sys.argv[2]); result = [infer_predictions(data['artifact'], v) for v in data['vectors']]
    else:
        raise ValueError('arguments')
    print(json.dumps(result, allow_nan=False, separators=(',', ':')))


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Оценка отклонена: проверьте данные, регистрацию, сроки и численные контракты.', file=sys.stderr)
        sys.exit(1)
