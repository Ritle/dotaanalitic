import copy
import importlib.util
import json
import math
import os
from pathlib import Path
import random
import sys
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/research'))
spec = importlib.util.spec_from_file_location('player_hero_fit', ROOT / 'tools/research/player_hero_fit.py')
fit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fit)


def fixture():
    rng = random.Random(42); rows = []
    for split, n, time in [('train', 220, '2025-03-01T00:00:00.000Z'), ('validation', 60, '2026-05-02T00:00:00.000Z'), ('calibration', 60, '2026-07-02T00:00:00.000Z')]:
        for i in range(n):
            x, practice = 2 * math.sin(i * .7), math.cos(i * .4)
            rows.append({'matchId': str(len(rows)+1), 'seriesKey': f'{split}:{i//2}', 'split': split, 'cutoffAtUs': str(fit.micros(time)),
                         'inputs': {'eloLogit': x, 'observedHeroPracticeLog90Delta': practice}, 'label': rng.random() < 1/(1+math.exp(-.8*x-.15*practice)),
                         'labelCompletedAtUs': str(fit.micros(time)+3600000000), 'labelVerifiedAtUs': str(fit.micros('2026-11-01T00:00:00.000Z')), 'receiptSha256': 'a'*64})
    return {'format': 'player-hero-fit-input-v1', 'protocolFingerprint': 'a'*64, 'datasetSha256': 'b'*64, 'labelsSha256': 'c'*64,
            'policy': fit.load_json(fit.POLICY_PATH), 'rows': rows, 'syntheticOnly': True}


def test_deterministic_fit_research_only_and_freeze_before_calibration():
    data=fixture(); original=copy.deepcopy(data); selections=[]
    a=fit.fit_models(data, selections.append)
    assert data==original and a==fit.fit_models(data)
    assert a['counts']=={'train':220,'validation':60,'calibration':60}
    assert a['deployable'] is False and a['developmentTestConsumed'] is False
    assert len(selections)==1 and all('calibration' not in m for m in selections[0].values())
    for name in ('H1','H2'):
        m=a['models'][name]; assert m['status']=='fitted' and m['selectedC'] in [.01,.1,1]
        assert m['coefficients']==selections[0][name]['coefficients']
    assert {g['case'] for g in a['goldens']}==set(data['policy']['environment']['parityCases'])


def test_calibration_labels_and_features_cannot_select_coefficients():
    data=fixture(); a=fit.fit_models(data)
    for r in data['rows']:
        if r['split']=='calibration':
            r['label']=not r['label']; r['inputs']['observedHeroPracticeLog90Delta']*=10
    b=fit.fit_models(data)
    for name in ('H1','H2'):
        for key in ('selectedC','coefficients','candidates','featureOrder'):
            assert a['models'][name][key]==b['models'][name][key]


def test_selected_coefficients_are_train_only_no_refit():
    data=fixture(); result=fit.fit_models(data); rows=fit.validate_input(data)
    for name in ('H1','H2'):
        x={s:np.asarray([fit.vector(r['inputs']) for r in rs]) for s,rs in rows.items()}
        if name=='H1': x={s:a[:,:1] for s,a in x.items()}
        y={s:np.asarray([int(r['label']) for r in rs]) for s,rs in rows.items()}
        _,model=fit.fit_candidate(x['train'],y['train'],x['validation'],y['validation'],result['models'][name]['selectedC'],data['policy']['fitting'])
        assert model.coef_[0].tolist()==result['models'][name]['coefficients']


@pytest.mark.parametrize('mutation',['late','duplicate','series','nonfinite','boolean_feature','label','extra','policy','clock','completion','receipt','empty','one_class'])
def test_rejects_leakage_invalid_data_or_changed_policy(mutation):
    d=fixture(); r=d['rows'][0]
    if mutation=='late': r['split']='development_test'
    elif mutation=='duplicate': d['rows'][-1]['matchId']=r['matchId']
    elif mutation=='series': d['rows'][-1]['seriesKey']=r['seriesKey']
    elif mutation=='nonfinite': r['inputs']['eloLogit']=float('nan')
    elif mutation=='boolean_feature': r['inputs']['observedHeroPracticeLog90Delta']=False
    elif mutation=='label': r['label']=1
    elif mutation=='extra': r['inputs']['winner']=True
    elif mutation=='policy': d['policy']['fitting']['CGrid']=[1]
    elif mutation=='clock': r['cutoffAtUs']=str(fit.micros('2026-09-01T00:00:00.000Z'))
    elif mutation=='completion': r['labelCompletedAtUs']=r['cutoffAtUs']
    elif mutation=='receipt': r['receiptSha256']='unknown'
    elif mutation=='empty': d['rows']=[]
    elif mutation=='one_class':
        for item in d['rows']: item['label']=True
    with pytest.raises(ValueError): fit.validate_input(d)


def test_zero_and_missing_annotation_do_not_add_features_or_penalties():
    assert fit.vector({'eloLogit':0,'observedHeroPracticeLog90Delta':0})==[0.,0.]
    result=fit.fit_models(fixture())
    ordinary=result['goldens'][0]; missing=next(g for g in result['goldens'] if g['case']=='missing_history_annotations')
    assert ordinary['inputs']==missing['inputs'] and ordinary['expected']==missing['expected']
    missing_cal=next(g for g in result['goldens'] if g['case']=='calibrator_unavailable')
    for name in ('H1','H2'): assert missing_cal['expected'][name]['calibratedProbability'] is None


def test_invalid_candidates_and_calibrator_boundary_are_not_promoted(monkeypatch):
    def invalid(*args): return {'C':args[4],'status':'invalid','reason':'CONVERGENCE_FAILURE'},None
    monkeypatch.setattr(fit,'fit_candidate',invalid)
    result=fit.fit_models(fixture())
    assert all(m['status']=='unavailable' for m in result['models'].values())
    assert all(set(g['expected'])=={'H0'} for g in result['goldens'])
    c=fit.calibrate(np.array([-2.,2.]*40),np.array([0,1]*40),fixture()['policy']['calibration'])
    assert c['status']=='insufficient' and c['reason']=='CALIBRATION_BOUNDARY'
    assert fit.choose_candidate([{'C':1,'status':'valid','validationLogLoss':.4},{'C':.1,'status':'valid','validationLogLoss':.4+5e-13}])['C']==.1


def test_sign_symmetry_extreme_logits_and_export():
    result=fit.fit_models(fixture())
    for a,b in zip(result['goldens'][:256:2],result['goldens'][1:256:2]):
        for n in a['expected']:
            for k in ('rawProbability','calibratedProbability'):
                if a['expected'][n][k] is not None: assert abs(a['expected'][n][k]+b['expected'][n][k]-1)<1e-12
    if os.environ.get('DOTA_PLAYER_HERO_PARITY_OUTPUT'):
        result.update(manifestSha256='a'*64,fitInputSha256='b'*64,datasetSha256='c'*64,labelsSha256='d'*64,protocolFingerprint='e'*64,selectedSha256='f'*64)
        with Path(os.environ['DOTA_PLAYER_HERO_PARITY_OUTPUT']).open('x',encoding='utf8') as f: json.dump(result,f,allow_nan=False)
