"""Offline H1/H2 research. No DB, providers, late development scoring or activation."""
from __future__ import annotations
import hashlib
import json
import math
import re
import sys
from pathlib import Path
import numpy as np
from scipy.special import expit
from post_draft_fit import environment, load_json, micros, fit_candidate, choose_candidate, calibrate

POLICY_PATH = Path(__file__).with_name('player-hero-experiment-policy.json')
SPLITS = ('train', 'validation', 'calibration')
ORDER = ['eloLogit', 'observedHeroPracticeLog90Delta']


def vector(inputs):
    if not isinstance(inputs, dict) or set(inputs) != set(ORDER) or any(type(inputs[k]) not in (int, float) or not math.isfinite(inputs[k]) for k in ORDER):
        raise ValueError('invalid_features')
    return [float(inputs[k]) for k in ORDER]


def validate_input(data):
    if set(data) != {'format', 'protocolFingerprint', 'datasetSha256', 'labelsSha256', 'policy', 'rows', 'syntheticOnly'}:
        raise ValueError('input_fields')
    if data['format'] != 'player-hero-fit-input-v1' or type(data['syntheticOnly']) is not bool or data['policy'] != load_json(POLICY_PATH):
        raise ValueError('input_policy')
    for key in ('protocolFingerprint', 'datasetSha256', 'labelsSha256'):
        if not isinstance(data[key], str) or not re.fullmatch('[a-f0-9]{64}', data[key]):
            raise ValueError('invalid_hash')
    if not isinstance(data['rows'], list) or len(data['rows']) > 5000:
        raise ValueError('map_limit')
    rows = {k: [] for k in SPLITS}
    seen, series = set(), {}
    windows = {w['name']: w for w in data['policy']['windows']}
    for r in data['rows']:
        if set(r) != {'matchId', 'seriesKey', 'split', 'cutoffAtUs', 'inputs', 'label', 'labelCompletedAtUs', 'labelVerifiedAtUs', 'receiptSha256'} or r['split'] not in SPLITS:
            raise ValueError('late_split_or_fields')
        if not isinstance(r['matchId'], str) or not re.fullmatch('[1-9][0-9]{0,18}', r['matchId']) or int(r['matchId']) > 9223372036854775807 or r['matchId'] in seen or type(r['label']) is not bool:
            raise ValueError('duplicate_or_invalid_label')
        seen.add(r['matchId'])
        if not isinstance(r['seriesKey'], str) or not r['seriesKey'] or series.setdefault(r['seriesKey'], r['split']) != r['split']:
            raise ValueError('series_crosses_split')
        for key in ('cutoffAtUs', 'labelCompletedAtUs', 'labelVerifiedAtUs'):
            if not isinstance(r[key], str) or not re.fullmatch('[0-9]{1,19}', r[key]):
                raise ValueError('invalid_clock')
        cutoff, end, verified = (int(r[k]) for k in ('cutoffAtUs', 'labelCompletedAtUs', 'labelVerifiedAtUs'))
        w = windows[r['split']]
        if not micros(w['from']) <= cutoff < end < micros(w['until']) or verified < end:
            raise ValueError('invalid_split_or_label_clock')
        if not isinstance(r['receiptSha256'], str) or not re.fullmatch('[a-f0-9]{64}', r['receiptSha256']):
            raise ValueError('invalid_receipt')
        vector(r['inputs'])
        rows[r['split']].append(r)
    floors = data['policy']['sampleFloors']
    for name, block in rows.items():
        if len(block) < floors[name + 'Maps'] or min(sum(r['label'] for r in block), sum(not r['label'] for r in block)) < floors['minEachLabelPerFittedOrScoredBlock']:
            raise ValueError('fitting_sample_floor')
    return rows


def fit_models(data, on_selected=lambda selected: None):
    rows = validate_input(data)
    matrices = {s: np.asarray([vector(r['inputs']) for r in rows[s]]) for s in SPLITS}
    labels = {s: np.asarray([int(r['label']) for r in rows[s]]) for s in SPLITS}
    models, estimators = {}, {}
    for name in ('H1', 'H2'):
        x = {s: a[:, :1] if name == 'H1' else a for s, a in matrices.items()}
        records, fitted = [], {}
        for c in data['policy']['fitting']['CGrid']:
            record, estimator = fit_candidate(x['train'], labels['train'], x['validation'], labels['validation'], c, data['policy']['fitting'])
            records.append(record)
            if estimator is not None:
                fitted[c] = estimator
        best = choose_candidate(records)
        if best is None:
            models[name] = {'status': 'unavailable', 'reason': 'NO_CONVERGED_CANDIDATE', 'candidates': records}
            continue
        estimator = fitted[best['C']]
        models[name] = {'status': 'fitted', 'selectedC': best['C'], 'candidates': records, 'featureOrder': ORDER[:1] if name == 'H1' else ORDER[:],
                        'coefficients': estimator.coef_[0].tolist(), 'intercept': 0}
        estimators[name] = estimator
    # CLI persists these exact coefficients BEFORE temperature fitting; verify compares the same selection again.
    on_selected(json.loads(json.dumps(models)))
    for name, estimator in estimators.items():
        x = matrices['calibration'][:, :1] if name == 'H1' else matrices['calibration']
        models[name]['calibration'] = calibrate(estimator.decision_function(x), labels['calibration'], data['policy']['calibration'])
    probes = []
    for r in rows['train'][:128]:
        probes.extend([('ordinary', r['inputs']), ('swapped_A_B', {k: -r['inputs'][k] for k in ORDER})])
    probes.extend([('zero_practice', {'eloLogit': .4, 'observedHeroPracticeLog90Delta': 0}),
                   ('missing_history_annotations', rows['train'][0]['inputs']),
                   ('calibrator_unavailable', rows['train'][0]['inputs'])])
    for value in (-1000, 0, 1000):
        probes.append(('extreme_logits', {'eloLogit': value, 'observedHeroPracticeLog90Delta': value}))
    goldens = []
    for case, inputs in probes:
        full = np.asarray([vector(inputs)])
        p = float(expit(inputs['eloLogit']))
        expected = {'H0': {'rawProbability': p, 'calibratedProbability': p}}
        for name, estimator in estimators.items():
            x = full[:, :1] if name == 'H1' else full
            cal = models[name]['calibration']
            expected[name] = {'rawProbability': float(estimator.predict_proba(x)[0, 1]),
                              'calibratedProbability': float(expit(estimator.decision_function(x)[0] / cal['temperature'])) if cal['status'] == 'fitted' and case != 'calibrator_unavailable' else None}
        goldens.append({'case': case, 'annotations': ['HERO_HISTORY_INCOMPLETE'] if case == 'missing_history_annotations' else [], 'inputs': inputs, 'expected': expected})
    return {'format': 'player-hero-research-fit-v1', 'models': models, 'seed': 42, 'intercept': False, 'preprocessing': 'identity',
            'featureOrder': ORDER, 'counts': {s: len(rows[s]) for s in SPLITS}, 'developmentTestConsumed': False,
            'qualityGate': 'not_evaluated', 'syntheticOnly': data['syntheticOnly'], 'deployable': False, 'goldens': goldens}


def main():
    if sys.argv[1:] == ['environment']:
        print(json.dumps(environment(), sort_keys=True))
        return
    if len(sys.argv) != 3 or sys.argv[1] not in ('fit', 'verify'):
        raise ValueError('arguments')
    directory = Path(sys.argv[2]); mode = sys.argv[1]
    manifest_path = directory / 'manifest.json'; input_path = directory / 'fit-input.json'
    manifest = load_json(manifest_path)
    if hashlib.sha256(input_path.read_bytes()).hexdigest() != manifest['fitInputSha256'] or environment() != manifest['environment']['pythonEnvironment']:
        raise ValueError('input_or_environment_changed')
    root = Path(__file__).resolve().parents[2]
    for entry in manifest['code']:
        path = (root / entry['path']).resolve()
        if not path.is_relative_to(root) or hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError('executable_changed')
    data = load_json(input_path)
    if data['syntheticOnly'] is not False:
        raise ValueError('synthetic_cli_forbidden')
    bindings = {'manifestSha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(), 'fitInputSha256': manifest['fitInputSha256'],
                'datasetSha256': data['datasetSha256'], 'labelsSha256': data['labelsSha256'], 'protocolFingerprint': data['protocolFingerprint']}

    def freeze_selected(models):
        selected = {'format': 'player-hero-selected-coefficients-v1', **bindings, 'models': models, 'calibrationPerformed': False, 'deployable': False}
        path = directory / 'selected.json'
        if mode == 'fit':
            with path.open('x', encoding='utf8', newline='\n') as handle:
                json.dump(selected, handle, allow_nan=False, separators=(',', ':')); handle.write('\n')
        elif load_json(path) != selected:
            raise ValueError('selected_replay')

    result = fit_models(data, freeze_selected)
    result.update(bindings, selectedSha256=hashlib.sha256((directory / 'selected.json').read_bytes()).hexdigest())
    if mode == 'fit':
        with (directory / 'artifact.json').open('x', encoding='utf8', newline='\n') as handle:
            json.dump(result, handle, allow_nan=False, separators=(',', ':')); handle.write('\n')
    elif load_json(directory / 'artifact.json') != result:
        raise ValueError('fit_replay')
    print(json.dumps({'status': 'fitted_research_only' if mode == 'fit' else 'verified_deterministic_fit', 'developmentTestConsumed': False, 'deployable': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Обучение отклонено: проверьте протокол, входы, окружение и отдельный путь результата.', file=sys.stderr)
        sys.exit(1)
