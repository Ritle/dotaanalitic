import copy
import importlib.util
import math
from pathlib import Path
import sys
import numpy as np
import pytest
from sklearn.metrics import log_loss,brier_score_loss

ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'tools/research'))
spec=importlib.util.spec_from_file_location('player_hero_evaluate',ROOT/'tools/research/player_hero_evaluate.py')
ev=importlib.util.module_from_spec(spec);spec.loader.exec_module(ev)
def pred(p):return {'probability':p,'logit':math.log(p/(1-p))}
def fixture(n=120,excluded=0,bad=False):
    rows=[]
    for i in range(n+excluded):
        valid=i<n;label=i%2==0
        ps={k:None for k in ev.VARIANTS}
        if valid:
            for k,p in [('H0',.55),('H1_raw',.58),('H1_cal',.6),('H2_raw',.8),('H2_cal',.05 if bad else .95)]:ps[k]=pred(p if label else 1-p)
        rows.append({'matchId':str(i+1),'seriesKey':'s'+str(i//2) if valid else None,'startedAt':'2026-09-10T00:00:00.000Z',
         'baselineEligible':valid,'pairedEligible':valid,'reasons':[] if valid else ['INSUFFICIENT_HISTORY'],'label':label if valid else None,'predictions':ps,
         'annotations':{'provider':'opendota' if valid else None,'leagueId':'1','providerPatchId':60,'canonicalPatchId':None,'monthUTC':'2026-09',
          'hasUnknownHeroHistory':False if valid else None,'hasZeroObservedHeroCount':True if valid else None}})
    return {'format':'player-hero-evaluation-input-v1','policy':ev.load_json(ev.POLICY_PATH),'rows':rows,'plannedDenominator':len(rows),
     'upstreamDataChecks':{'status':'passed_data_floors_only','reasons':[]},'parityPassed':True,'syntheticOnly':True,
     'sourceHashes':{k:'a'*64 for k in ['plan','dataset','labels','features','inventory','metadata','fitManifest','fitArtifact','fitResult']}}

def test_metrics_match_sklearn_and_manual_reliability():
    rows=fixture(4)['rows'];ps=[.1,.3,.7,.9]
    for r,p in zip(rows,ps):r['predictions']['H0']=pred(p)
    m=ev.metrics(rows,'H0');y=[int(r['label']) for r in rows]
    assert m['logLoss']==pytest.approx(log_loss(y,ps),abs=1e-14)
    assert m['brier']==pytest.approx(brier_score_loss(y,ps),abs=1e-14)
    assert m['ece']==pytest.approx(sum(abs(p-v) for p,v in zip(ps,y))/4)

def test_empty_null_extreme_logits_and_empty_missingness_groups():
    report=ev.evaluate(fixture(0));assert report['decision']['status']=='insufficient'
    for m in report['pairedMetrics'].values():assert m['logLoss'] is None and m['ece'] is None
    assert {x['value'] for x in report['strata']['hasZeroObservedHeroCount']}=={'false','true'}
    assert all(x['metrics']['H2_cal']['observedRate'] is None for x in report['strata']['hasUnknownHeroHistory'])
    d=fixture(2);d['rows'][0]['predictions']['H0']={'probability':0,'logit':-1000};d['rows'][1]['predictions']['H0']={'probability':1,'logit':1000}
    ev.validate(d);assert ev.metrics(d['rows'],'H0')['logLoss']==1000

def test_whole_unequal_series_bootstrap_is_map_weighted(monkeypatch):
    rows=fixture(3)['rows'];rows[0]['seriesKey']=rows[1]['seriesKey']='A';rows[2]['seriesKey']='B';rows[2]['predictions']['H2_cal']=pred(.01)
    monkeypatch.setattr(ev.numerical,'block_draws',lambda *args:np.array([[0,0],[1,1]]))
    losses=[ev.numerical.losses(r,'H2_cal')[0]-ev.numerical.losses(r,'H1_cal')[0] for r in rows]
    result=ev.bootstrap(rows,{'replicates':2,'seed':42})['deltas']['logLoss_H2_cal_minus_H1_cal']
    assert result['mean']==pytest.approx(sum(losses)/3)
    assert [result['lower'],result['upper']]==pytest.approx(np.quantile([np.mean(losses[:2]),losses[2]],[.025,.975],method='linear'))

def test_deterministic_order_independent_and_no_input_mutation():
    d=fixture();original=copy.deepcopy(d);r=ev.evaluate(d);assert d==original
    d['rows'].reverse();assert ev.evaluate(d)==r

def test_positive_signal_never_promotes_and_coverage_overrides():
    r=ev.evaluate(fixture());assert r['decision']['status']=='positive_research_only' and r['deployable'] is False and r['releaseGatePassed'] is False
    r=ev.evaluate(fixture(excluded=40));assert r['decision']['status']=='insufficient' and r['decision']['metricSignal']=='positive'
    assert r['counts']['plannedDenominator']==160 and r['counts']['unavailableMaps']==40

def test_negative_kept_no_raw_fallback_and_upstream_failures_preserved():
    r=ev.evaluate(fixture(bad=True));assert r['decision']['status']=='negative'
    assert 'NO_SIGNIFICANT_LOGLOSS_GAIN_OVER_H1' in r['decision']['metricReasons']
    assert r['pairedMetrics']['H2_raw']['brier']<r['pairedMetrics']['H2_cal']['brier']
    d=fixture();d['upstreamDataChecks']={'status':'insufficient','reasons':['TRAIN_FLOOR']}
    assert ev.evaluate(d)['decision']['dataReasons']==['TRAIN_FLOOR']

def test_unavailable_calibration_excludes_whole_series_and_retains_raw_diagnostics():
    d=fixture();d['rows'][0]['predictions']['H2_cal']=None;d['rows'][0]['reasons']=['H2_CALIBRATION_UNAVAILABLE']
    r=ev.evaluate(d);assert {m['n'] for m in r['pairedMetrics'].values()}=={118}
    assert r['availableMetricsDiagnosticOnly']['H2_raw']['n']==120 and r['availableMetricsDiagnosticOnly']['H2_cal']['n']==119
    assert r['counts']['baselineOnlyMaps']==2 and r['counts']['plannedDenominator']==120
    assert r['predictionUnavailableSeries']==['s0'] and 'PAIRED_PREDICTIONS_UNAVAILABLE' in r['decision']['dataReasons']

def test_all_strata_are_reported_without_subgroup_selection():
    d=fixture();d['rows'][0]['annotations']['leagueId']='999';d['rows'][0]['annotations']['hasUnknownHeroHistory']=True
    r=ev.evaluate(d);assert len(r['strata']['leagueId'])==2
    assert next(x for x in r['strata']['hasUnknownHeroHistory'] if x['value']=='true')['maps']==1
    assert next(x for x in r['strata']['hasZeroObservedHeroCount'] if x['value']=='false')['metrics']['H2_cal']['logLoss'] is None
    assert r['strata']['canonicalPatchId'][0]['value']=='unknown'

@pytest.mark.parametrize('kind',['duplicate','window','date','denominator','nan','probability','label','policy','parity','partial_series','missing_annotation','extra','source'])
def test_invalid_inputs_fail_closed(kind):
    d=fixture();r=d['rows'][0]
    if kind=='duplicate':d['rows'][1]['matchId']=r['matchId']
    elif kind=='window':r['startedAt']='2026-05-01T00:00:00.000Z'
    elif kind=='date':r['startedAt']='2026-09-99T00:00:00.000Z'
    elif kind=='denominator':d['plannedDenominator']-=1
    elif kind=='nan':r['predictions']['H0']['logit']=float('nan')
    elif kind=='probability':r['predictions']['H0']['probability']=.1
    elif kind=='label':r['label']=1
    elif kind=='policy':d['policy']['evaluation']['bootstrap']['seed']=99
    elif kind=='parity':d['parityPassed']=False
    elif kind=='partial_series':
        r['pairedEligible']=False
        for k in ev.VARIANTS[1:]:r['predictions'][k]=None
    elif kind=='missing_annotation':r['annotations']['hasZeroObservedHeroCount']=None
    elif kind=='extra':r['predictions']['H0']['winner']=True
    elif kind=='source':d['sourceHashes']['dataset']='unknown'
    with pytest.raises(ValueError):ev.evaluate(d)
