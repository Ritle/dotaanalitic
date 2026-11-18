"""Offline conditional research only. No registry, database, late-test scoring or pickle."""
from __future__ import annotations
import hashlib
import importlib.metadata
import json
import math
import platform
import re
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
from scipy.optimize import minimize_scalar
from scipy.special import expit
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from threadpoolctl import threadpool_info

POLICY_PATH = Path(__file__).with_name('post-draft-policy.json')
SPLITS = ('train', 'validation', 'calibration')


def environment():
    return {'python': platform.python_version(), 'implementation': platform.python_implementation(),
            'platform': platform.platform(), 'machine': platform.machine(),
            'threadpools': [{k: v for k, v in pool.items() if k != 'filepath'} for pool in threadpool_info()],
            'executableSha256': hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest(),
            'packages': sorted([{'name': d.metadata['Name'], 'version': d.version}
                                for d in importlib.metadata.distributions()], key=lambda d: (d['name'].lower(), d['version']))}


def load_json(path):
    path = Path(path)
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('file_limit')
    return json.loads(path.read_text(encoding='utf-8-sig'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite_json')))


def micros(iso):
    delta = datetime.fromisoformat(iso.replace('Z', '+00:00')) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86400 + delta.seconds) * 1000000 + delta.microseconds


def vector(inputs, vocabulary):
    if set(inputs) != {'eloLogit', 'signedHeroes'} or type(inputs['eloLogit']) not in (int, float) or not math.isfinite(inputs['eloLogit']):
        raise ValueError('invalid_elo')
    heroes = inputs['signedHeroes']
    if len(heroes) != 10 or any(set(h) != {'heroId', 'value'} or type(h['heroId']) is not int or
                              h['heroId'] not in vocabulary or type(h['value']) is not int or h['value'] not in (-1, 1) for h in heroes):
        raise ValueError('invalid_heroes')
    if len({h['heroId'] for h in heroes}) != 10 or sum(h['value'] for h in heroes) != 0:
        raise ValueError('invalid_hero_sides')
    by_id = {h['heroId']: h['value'] for h in heroes}
    return [float(inputs['eloLogit'])] + [by_id.get(h, 0) for h in vocabulary]


def validate_input(data):
    if set(data) != {'format', 'protocolFingerprint', 'datasetSha256', 'policy', 'heroVocabulary', 'rows', 'dataChecks', 'syntheticOnly'}:
        raise ValueError('input_fields')
    if data['format'] != 'conditional-post-draft-fit-input-v1' or type(data['syntheticOnly']) is not bool:
        raise ValueError('input_format')
    for field in ('protocolFingerprint', 'datasetSha256'):
        if not re.fullmatch('[a-f0-9]{64}', data[field]):
            raise ValueError('input_hash')
    if data['policy'] != load_json(POLICY_PATH):
        raise ValueError('policy_changed')
    vocab = data['heroVocabulary']
    if not vocab or any(type(h) is not int or h <= 0 for h in vocab) or sorted(set(vocab)) != vocab:
        raise ValueError('invalid_vocabulary')
    windows = {w['name']: w for w in data['policy']['windows']}
    seen, groups, train_heroes = set(), {}, set()
    rows = {k: [] for k in SPLITS}
    if len(data['rows']) > 5000:
        raise ValueError('map_limit')
    for r in data['rows']:
        if set(r) != {'matchId', 'seriesKey', 'split', 'cutoffAtUs', 'inputs', 'label'} or r['split'] not in SPLITS:
            raise ValueError('fit_split_or_fields')
        if not re.fullmatch('[1-9][0-9]{0,18}', r['matchId']) or r['matchId'] in seen or type(r['label']) is not bool:
            raise ValueError('duplicate_or_invalid_label')
        seen.add(r['matchId'])
        if not isinstance(r['seriesKey'], str) or not r['seriesKey'] or groups.setdefault(r['seriesKey'], r['split']) != r['split']:
            raise ValueError('series_crosses_split')
        w = windows[r['split']]
        if not isinstance(r['cutoffAtUs'], str) or not r['cutoffAtUs'].isdigit() or not micros(w['from']) <= int(r['cutoffAtUs']) < micros(w['until']):
            raise ValueError('cutoff_outside_split')
        vector(r['inputs'], vocab)
        rows[r['split']].append(r)
        if r['split'] == 'train':
            train_heroes.update(h['heroId'] for h in r['inputs']['signedHeroes'])
    if sorted(train_heroes) != vocab:
        raise ValueError('non_train_vocabulary')
    floors = data['policy']['sampleFloors']
    for name, block in rows.items():
        if len(block) < floors[name + 'Maps'] or min(sum(r['label'] for r in block), sum(not r['label'] for r in block)) < floors['minEachLabelPerFittedOrScoredBlock']:
            raise ValueError('fitting_sample_floor')
    return rows


def nll(logits, labels):
    logits, labels = np.asarray(logits, dtype=float), np.asarray(labels, dtype=float)
    return float(np.mean(np.logaddexp(0, logits) - labels * logits))


def fit_candidate(x, y, x_val, y_val, c, policy):
    model = LogisticRegression(C=c, l1_ratio=0.0, fit_intercept=False, solver=policy['solver'],
                               max_iter=policy['maxIterations'], tol=policy['tolerance'], class_weight=None,
                               random_state=42, warm_start=False)
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter('always', ConvergenceWarning)
        model.fit(x, y)
    if any(issubclass(w.category, ConvergenceWarning) for w in captured) or not np.isfinite(model.coef_).all():
        return {'C': c, 'status': 'invalid', 'reason': 'CONVERGENCE_FAILURE'}, None
    loss = nll(model.decision_function(x_val), y_val)
    if not math.isfinite(loss):
        return {'C': c, 'status': 'invalid', 'reason': 'NONFINITE_VALIDATION_LOSS'}, None
    return {'C': c, 'status': 'valid', 'validationLogLoss': loss, 'iterations': int(model.n_iter_[0])}, model


def choose_candidate(candidates):
    best = None
    for item in sorted(candidates, key=lambda c: c['C']):
        if item['status'] == 'valid' and (best is None or item['validationLogLoss'] < best['validationLogLoss'] - 1e-12):
            best = item
    return best


def calibrate(logits, labels, policy):
    lo, hi = policy['TBounds']
    result = minimize_scalar(lambda t: nll(logits / t, labels), method='bounded', bounds=(lo, hi),
                             options={'xatol': policy['xTolerance'], 'maxiter': policy['maxIterations']})
    finite = math.isfinite(float(result.x)) and math.isfinite(float(result.fun))
    boundary = finite and (result.x <= lo + 1e-6 or result.x >= hi - 1e-6)
    reason = 'CALIBRATION_NONCONVERGENCE' if not result.success or not finite else 'CALIBRATION_BOUNDARY' if boundary else None
    return {'status': 'fitted' if reason is None else 'insufficient', 'temperature': float(result.x) if finite else None,
            'reason': reason, 'calibrationLogLoss': float(result.fun) if finite else None, 'bounds': [lo, hi]}


def fit_models(data):
    rows = validate_input(data)
    matrices = {s: np.asarray([vector(r['inputs'], data['heroVocabulary']) for r in rows[s]], dtype=float) for s in SPLITS}
    labels = {s: np.asarray([int(r['label']) for r in rows[s]]) for s in SPLITS}
    models, estimators = {}, {}
    for name in ('M1', 'M2'):
        x = {s: a[:, :1] if name == 'M1' else a for s, a in matrices.items()}
        candidates, fitted = [], {}
        for c in data['policy']['models']['CGrid']:
            record, model = fit_candidate(x['train'], labels['train'], x['validation'], labels['validation'], c, data['policy']['models'])
            candidates.append(record)
            if model is not None:
                fitted[c] = model
        best = choose_candidate(candidates)
        if best is None:
            models[name] = {'status': 'unavailable', 'reason': 'NO_CONVERGED_CANDIDATE', 'candidates': candidates}
            continue
        model = fitted[best['C']]
        models[name] = {'status': 'fitted', 'selectedC': best['C'], 'candidates': candidates,
                        'featureOrder': ['eloLogit'] + ([] if name == 'M1' else ['hero:' + str(h) for h in data['heroVocabulary']]),
                        'coefficients': model.coef_[0].tolist(), 'intercept': 0,
                        'calibration': calibrate(model.decision_function(x['calibration']), labels['calibration'], data['policy']['calibration'])}
        estimators[name] = model
    # Golden probabilities use sklearn predict_proba, not the hand-written TS formula.
    inputs = []
    for r in rows['train'][:128]:
        inputs.extend([r['inputs'], {'eloLogit': -r['inputs']['eloLogit'], 'signedHeroes': [{'heroId': h['heroId'], 'value': -h['value']} for h in r['inputs']['signedHeroes']]}])
    inputs.extend([{'eloLogit': value, 'signedHeroes': rows['train'][0]['inputs']['signedHeroes']} for value in (-1000, 0, 1000)])
    goldens = []
    for inputs_row in inputs:
        full = np.asarray([vector(inputs_row, data['heroVocabulary'])])
        expected = {'M0': {'rawProbability': float(expit(inputs_row['eloLogit'])), 'calibratedProbability': float(expit(inputs_row['eloLogit']))}}
        for name, model in estimators.items():
            x = full[:, :1] if name == 'M1' else full
            cal = models[name]['calibration']
            expected[name] = {'rawProbability': float(model.predict_proba(x)[0, 1]),
                              'calibratedProbability': float(expit(model.decision_function(x)[0] / cal['temperature'])) if cal['status'] == 'fitted' else None}
        goldens.append({'inputs': inputs_row, 'expected': expected})
    return {'format': 'conditional-logistic-research-fit-v1', 'models': models, 'heroVocabulary': data['heroVocabulary'],
            'seed': 42, 'intercept': False, 'preprocessing': 'none', 'counts': {s: len(rows[s]) for s in SPLITS},
            'dataChecks': data['dataChecks'], 'developmentTestConsumed': False, 'qualityGate': 'not_evaluated',
            'syntheticOnly': data['syntheticOnly'], 'deployable': False, 'goldens': goldens}


def main():
    if sys.argv[1:] == ['environment']:
        print(json.dumps(environment(), sort_keys=True))
        return
    if len(sys.argv) != 5 or sys.argv[1] != 'fit':
        raise ValueError('arguments')
    input_path, manifest_path, output_path = map(Path, sys.argv[2:])
    manifest = load_json(manifest_path)
    if hashlib.sha256(input_path.read_bytes()).hexdigest() != manifest['fitInputSha256'] or environment() != manifest['pythonEnvironment']:
        raise ValueError('input_or_environment_changed')
    root = Path(__file__).resolve().parents[2]
    for entry in manifest['code']:
        path = (root / entry['path']).resolve()
        if not path.is_relative_to(root) or hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError('executable_changed')
    data = load_json(input_path)
    if data['syntheticOnly'] is not False:
        raise ValueError('synthetic_cli_forbidden')
    result = fit_models(data)
    result.update(manifestSha256=hashlib.sha256(manifest_path.read_bytes()).hexdigest(), fitInputSha256=manifest['fitInputSha256'],
                  datasetSha256=data['datasetSha256'], protocolFingerprint=data['protocolFingerprint'])
    with output_path.open('x', encoding='utf-8', newline='\n') as handle:
        json.dump(result, handle, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        handle.write('\n')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Исследовательский расчёт не выполнен. Проверьте входы, manifest, окружение и отдельный путь результата.', file=sys.stderr)
        sys.exit(1)
