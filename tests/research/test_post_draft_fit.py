import copy
import importlib.util
import json
import math
import random
from pathlib import Path
from types import SimpleNamespace
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('post_draft_fit', ROOT / 'tools/research/post_draft_fit.py')
fit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fit)


def fixture():
    rng = random.Random(42)
    rows = []
    for split, count, time in [('train', 220, '2025-03-01T00:00:00.000Z'), ('validation', 60, '2026-05-02T00:00:00.000Z'), ('calibration', 60, '2026-07-02T00:00:00.000Z')]:
        for i in range(count):
            x = 2 * math.sin(i * .7)
            signs = [1 if (h + i) % 10 < 5 else -1 for h in range(10)]
            rows.append({'matchId': str(len(rows) + 1), 'seriesKey': 'series:' + split + ':' + str(i // 2), 'split': split,
                         'cutoffAtUs': str(fit.micros(time)), 'inputs': {'eloLogit': x, 'signedHeroes': [{'heroId': h + 1, 'value': signs[h]} for h in range(10)]},
                         'label': rng.random() < 1 / (1 + math.exp(-.8 * x - .15 * signs[0]))})
    return {'format': 'conditional-post-draft-fit-input-v1', 'protocolFingerprint': 'a' * 64, 'datasetSha256': 'b' * 64,
            'policy': fit.load_json(fit.POLICY_PATH), 'heroVocabulary': list(range(1, 11)), 'rows': rows,
            'dataChecks': {'status': 'insufficient', 'reasons': ['DEVELOPMENT_TEST_COVERAGE_BELOW_0_80'], 'activationAllowed': False}, 'syntheticOnly': True}


def test_fit_is_deterministic_research_only_and_does_not_mutate_inputs():
    data = fixture()
    before = copy.deepcopy(data)
    first = fit.fit_models(data)
    assert data == before
    assert first == fit.fit_models(data)
    assert first['deployable'] is False and first['developmentTestConsumed'] is False
    assert first['dataChecks']['status'] == 'insufficient'
    assert first['counts'] == {'train': 220, 'validation': 60, 'calibration': 60}
    assert len(first['goldens']) >= 100
    for model in first['models'].values():
        assert model['status'] == 'fitted'
        assert model['intercept'] == 0
        assert model['selectedC'] in [.01, .1, 1]


def test_calibration_labels_cannot_change_coefficients_or_selected_c():
    data = fixture()
    a = fit.fit_models(data)
    for r in data['rows']:
        if r['split'] == 'calibration':
            r['label'] = not r['label']
    b = fit.fit_models(data)
    for name in ('M1', 'M2'):
        for key in ('selectedC', 'coefficients', 'candidates', 'featureOrder'):
            assert a['models'][name][key] == b['models'][name][key]


def test_selected_coefficients_come_from_train_only_no_refit():
    data = fixture()
    result = fit.fit_models(data)
    blocks = fit.validate_input(data)
    for name in ('M1', 'M2'):
        x = {s: np.asarray([fit.vector(r['inputs'], data['heroVocabulary']) for r in rs]) for s, rs in blocks.items()}
        if name == 'M1':
            x = {s: a[:, :1] for s, a in x.items()}
        y = {s: np.asarray([int(r['label']) for r in rs]) for s, rs in blocks.items()}
        _, model = fit.fit_candidate(x['train'], y['train'], x['validation'], y['validation'], result['models'][name]['selectedC'], data['policy']['models'])
        assert model.coef_[0].tolist() == result['models'][name]['coefficients']


@pytest.mark.parametrize('mutation', ['late', 'duplicate', 'series', 'unknown', 'nonfinite', 'label', 'threshold', 'clock'])
def test_rejects_leakage_invalid_fields_and_policy_mutations(mutation):
    data = fixture()
    if mutation == 'late':
        data['rows'][-1]['split'] = 'development_test'
    elif mutation == 'duplicate':
        data['rows'][-1]['matchId'] = data['rows'][0]['matchId']
    elif mutation == 'series':
        data['rows'][-1]['seriesKey'] = data['rows'][0]['seriesKey']
    elif mutation == 'unknown':
        data['rows'][-1]['inputs']['signedHeroes'][0]['heroId'] = 99
    elif mutation == 'nonfinite':
        data['rows'][0]['inputs']['eloLogit'] = float('nan')
    elif mutation == 'label':
        data['rows'][0]['label'] = 1
    elif mutation == 'threshold':
        data['policy']['sampleFloors']['trainMaps'] = 1
    elif mutation == 'clock':
        data['rows'][0]['cutoffAtUs'] = str(fit.micros('2026-09-01T00:00:00.000Z'))
    with pytest.raises(ValueError):
        fit.validate_input(data)


def test_empty_missing_class_and_non_train_vocabulary_are_not_imputed():
    for change in ('empty', 'class', 'vocab'):
        data = fixture()
        if change == 'empty':
            data['rows'] = []
        elif change == 'class':
            for r in data['rows']:
                r['label'] = True
        else:
            data['heroVocabulary'].append(99)
        with pytest.raises(ValueError):
            fit.validate_input(data)


def test_ties_choose_smaller_c_and_invalid_candidates_never_win():
    entries = [{'C': 1, 'status': 'valid', 'validationLogLoss': .4}, {'C': .1, 'status': 'valid', 'validationLogLoss': .4 + 5e-13}, {'C': .01, 'status': 'invalid'}]
    assert fit.choose_candidate(entries)['C'] == .1
    assert fit.choose_candidate([entries[-1]]) is None


def test_nonconverged_candidate_is_invalid():
    data = fixture()
    rows = fit.validate_input(data)
    x = np.asarray([fit.vector(r['inputs'], data['heroVocabulary']) for r in rows['train']])
    y = np.asarray([int(r['label']) for r in rows['train']])
    policy = dict(data['policy']['models'], maxIterations=1)
    result, model = fit.fit_candidate(x, y, x, y, .1, policy)
    assert result['status'] == 'invalid' and model is None


def test_calibration_boundary_and_nonconvergence_are_insufficient(monkeypatch):
    policy = fixture()['policy']['calibration']
    result = fit.calibrate(np.array([-2., 2.] * 40), np.array([0, 1] * 40), policy)
    assert result['status'] == 'insufficient' and result['reason'] == 'CALIBRATION_BOUNDARY'
    monkeypatch.setattr(fit, 'minimize_scalar', lambda *args, **kwargs: SimpleNamespace(x=1., fun=.4, success=False))
    assert fit.calibrate(np.array([-2., 2.]), np.array([0, 1]), policy)['reason'] == 'CALIBRATION_NONCONVERGENCE'


def test_stable_loss_extreme_logits_and_sign_symmetry():
    assert math.isfinite(fit.nll(np.array([-10000., 10000.]), np.array([1, 0])))
    result = fit.fit_models(fixture())
    for first, flipped in zip(result['goldens'][0:256:2], result['goldens'][1:256:2]):
        for name in first['expected']:
            for key in ('rawProbability', 'calibratedProbability'):
                a, b = first['expected'][name][key], flipped['expected'][name][key]
                if a is not None:
                    assert abs(a + b - 1) < 1e-12


def test_golden_export_for_typescript(tmp_path):
    # Optional explicit path is used only by the test orchestrator, never by production CLI.
    import os
    output = os.environ.get('DOTA_SYNTHETIC_PARITY_OUTPUT')
    if output:
        result = fit.fit_models(fixture())
        result.update(manifestSha256='a' * 64, fitInputSha256='b' * 64, datasetSha256='c' * 64, protocolFingerprint='d' * 64)
        with Path(output).open('x', encoding='utf-8') as handle:
            json.dump(result, handle, allow_nan=False)
