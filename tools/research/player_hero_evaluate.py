"""Frozen H0/H1/H2 development evaluation; no fitting or promotion."""
from __future__ import annotations
import hashlib
import json
import math
import re
import sys
from datetime import datetime
from pathlib import Path
from scipy.special import expit
import post_draft_evaluate as numerical
from post_draft_fit import environment, load_json

POLICY_PATH = Path(__file__).with_name('player-hero-experiment-policy.json')
VARIANTS = ('H0','H1_raw','H1_cal','H2_raw','H2_cal')
ANNOTATIONS = ('provider','leagueId','providerPatchId','canonicalPatchId','monthUTC','hasUnknownHeroHistory','hasZeroObservedHeroCount')
metrics = numerical.metrics


def bootstrap(rows, policy):
    # Explicit name adapter only; shared numeric implementation stays frozen.
    translated = [{**r, 'predictions': {k.replace('H','M',1):v for k,v in r['predictions'].items()}} for r in rows]
    result = numerical.bootstrap(translated, policy)
    result['deltas'] = {k.replace('M2','H2').replace('M1','H1').replace('M0','H0'):v for k,v in result['deltas'].items()}
    return result


def validate(data):
    if set(data) != {'format','policy','rows','plannedDenominator','upstreamDataChecks','parityPassed','sourceHashes','syntheticOnly'} or data['format'] != 'player-hero-evaluation-input-v1':
        raise ValueError('input_fields')
    if data['policy'] != load_json(POLICY_PATH) or data['parityPassed'] is not True or type(data['syntheticOnly']) is not bool:
        raise ValueError('policy_or_parity')
    if type(data['plannedDenominator']) is not int or not 0 <= data['plannedDenominator'] <= 5000 or len(data['rows']) != data['plannedDenominator']:
        raise ValueError('denominator_changed')
    if set(data['sourceHashes']) != {'plan','dataset','labels','features','inventory','metadata','fitManifest','fitArtifact','fitResult'} or any(not isinstance(v,str) or not re.fullmatch('[a-f0-9]{64}',v) for v in data['sourceHashes'].values()):
        raise ValueError('source_hash')
    checks=data['upstreamDataChecks']
    if set(checks) != {'status','reasons'} or checks['status'] not in ('passed_data_floors_only','insufficient') or not isinstance(checks['reasons'],list) or any(not isinstance(v,str) for v in checks['reasons']) or (checks['status']=='insufficient') != bool(checks['reasons']):
        raise ValueError('upstream_checks')
    window=next(w for w in data['policy']['windows'] if w['name']=='development_test')
    seen=set();groups={}
    for r in data['rows']:
        if set(r) != {'matchId','seriesKey','startedAt','baselineEligible','pairedEligible','reasons','label','annotations','predictions'}:
            raise ValueError('row_fields')
        if not isinstance(r['matchId'],str) or not re.fullmatch('[1-9][0-9]{0,18}',r['matchId']) or r['matchId'] in seen or int(r['matchId'])>9223372036854775807:
            raise ValueError('duplicate_map')
        seen.add(r['matchId'])
        if not isinstance(r['startedAt'],str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z',r['startedAt']) or not window['from']<=r['startedAt']<window['until']:
            raise ValueError('wrong_window')
        datetime.fromisoformat(r['startedAt'].replace('Z','+00:00'))
        if type(r['baselineEligible']) is not bool or type(r['pairedEligible']) is not bool or r['pairedEligible'] and not r['baselineEligible']:
            raise ValueError('eligibility')
        if r['label'] is not None and type(r['label']) is not bool:
            raise ValueError('label')
        if r['seriesKey'] is not None and (not isinstance(r['seriesKey'],str) or not r['seriesKey']):
            raise ValueError('series')
        if r['seriesKey']: groups.setdefault(r['seriesKey'],[]).append(r)
        if not isinstance(r['reasons'],list) or any(not isinstance(v,str) for v in r['reasons']) or not r['baselineEligible'] and not r['reasons']:
            raise ValueError('reasons')
        if set(r['predictions']) != set(VARIANTS) or set(r['annotations']) != set(ANNOTATIONS):
            raise ValueError('prediction_or_annotation_fields')
        if r['baselineEligible'] and (type(r['label']) is not bool or not r['seriesKey'] or r['predictions']['H0'] is None):
            raise ValueError('baseline_missing')
        ann=r['annotations']
        if ann['provider'] not in (None,'opendota') or ann['monthUTC'] != r['startedAt'][:7]:
            raise ValueError('provider_or_month')
        for k in ('leagueId','providerPatchId','canonicalPatchId'):
            v=ann[k]
            if v is not None and not (type(v) is int and v>=0 or isinstance(v,str) and re.fullmatch('[0-9]+',v)):
                raise ValueError('annotation_id')
        for k in ('hasUnknownHeroHistory','hasZeroObservedHeroCount'):
            if ann[k] is not None and type(ann[k]) is not bool or r['pairedEligible'] and type(ann[k]) is not bool:
                raise ValueError('missingness_annotation')
        for name,p in r['predictions'].items():
            if p is None: continue
            if not r['baselineEligible'] or name!='H0' and not r['pairedEligible']:
                raise ValueError('prediction_outside_cohort')
            if set(p)!={'logit','probability'} or any(type(v) not in (int,float) or not math.isfinite(v) for v in p.values()):
                raise ValueError('nonfinite_prediction')
            if not 0<=p['probability']<=1 or abs(float(expit(p['logit']))-p['probability'])>=1e-12:
                raise ValueError('probability_mismatch')
    for group in groups.values():
        if any(r['pairedEligible'] for r in group) and not all(r['pairedEligible'] for r in group):
            raise ValueError('partial_dataset_series')
    return sorted(data['rows'],key=lambda r:int(r['matchId']))


def evaluate(data):
    rows=validate(data)
    failed_series={r['seriesKey'] for r in rows if r['pairedEligible'] and any(r['predictions'][k] is None for k in VARIANTS)}
    paired=[r for r in rows if r['pairedEligible'] and r['seriesKey'] not in failed_series]
    baseline=[r for r in rows if r['baselineEligible']]; paired_ids={r['matchId'] for r in paired}
    by_model={k:metrics(paired,k) for k in VARIANTS};boot=bootstrap(paired,data['policy']['evaluation']['bootstrap'])
    n=len(paired);denominator=data['plannedDenominator'];coverage=n/denominator if denominator else None
    floors=data['policy']['sampleFloors'];data_reasons=list(data['upstreamDataChecks']['reasons'])
    if n<floors['developmentTestMaps']: data_reasons.append('DEVELOPMENT_TEST_MAPS_BELOW_FLOOR')
    if len({r['seriesKey'] for r in paired})<floors['developmentTestSeries']: data_reasons.append('DEVELOPMENT_TEST_SERIES_BELOW_FLOOR')
    if min(sum(r['label'] for r in paired),sum(not r['label'] for r in paired))<floors['minEachLabelPerFittedOrScoredBlock']: data_reasons.append('DEVELOPMENT_TEST_LABELS_BELOW_FLOOR')
    if (coverage or 0)<data['policy']['evaluation']['pairedCoverageMinimum']: data_reasons.append('DEVELOPMENT_TEST_COVERAGE_BELOW_0_80')
    if n!=sum(r['pairedEligible'] for r in rows): data_reasons.append('PAIRED_PREDICTIONS_UNAVAILABLE')
    reasons=[]
    if paired:
        h0,h1,h2=(by_model[k] for k in ('H0','H1_cal','H2_cal'))
        if boot['deltas']['logLoss_H2_cal_minus_H1_cal']['upper']>=0: reasons.append('NO_SIGNIFICANT_LOGLOSS_GAIN_OVER_H1')
        if h2['logLoss']>=h0['logLoss']: reasons.append('LOGLOSS_NOT_BETTER_THAN_H0')
        if h2['brier']>h0['brier']: reasons.append('BRIER_WORSE_THAN_H0')
        if h2['brier']>h1['brier']: reasons.append('BRIER_WORSE_THAN_H1')
        if h2['ece']>.10: reasons.append('H2_ECE_ABOVE_0_10')
    else: reasons.append('NO_PAIRED_SCORES')
    strata={}
    for key in ANNOTATIONS:
        groups={'false':[],'true':[]} if key.startswith('has') else {}
        for row in paired:
            v=row['annotations'][key];value='unknown' if v is None else str(v).lower() if type(v) is bool else str(v)
            groups.setdefault(value,[]).append(row)
        strata[key]=[{'value':v,'maps':len(group),'series':len({r['seriesKey'] for r in group}),
                      'metrics':{k:metrics(group,k) for k in VARIANTS}} for v,group in sorted(groups.items())]
    return {'format':'player-hero-evaluation-report-v1','basis':data['policy']['basis'],
            'counts':{'plannedDenominator':denominator,'datasetPairedMaps':sum(r['pairedEligible'] for r in rows),'pairedMaps':n,
                      'pairedSeries':len({r['seriesKey'] for r in paired}),'baselineMaps':len(baseline),
                      'baselineOnlyMaps':sum(r['matchId'] not in paired_ids for r in baseline),'unavailableMaps':sum(not r['baselineEligible'] for r in rows),'coverage':coverage},
            'pairedMetrics':by_model,'availableMetricsDiagnosticOnly':{k:metrics([r for r in rows if r['predictions'][k] is not None],k) for k in VARIANTS},
            'baselineAllMetrics':metrics(baseline,'H0'),'baselineOnlyMetrics':metrics([r for r in baseline if r['matchId'] not in paired_ids],'H0'),
            'bootstrap':boot,'strata':strata,'decision':{'status':'insufficient' if data_reasons else 'negative' if reasons else 'positive_research_only',
            'metricSignal':'unavailable' if not paired else 'negative' if reasons else 'positive','dataReasons':sorted(set(data_reasons)),'metricReasons':reasons},
            'exclusionReasons':{k:sum(k in r['reasons'] for r in rows) for k in sorted({k for r in rows for k in r['reasons']})},
            'predictionUnavailableSeries':sorted(failed_series),'sourceHashes':data['sourceHashes'],'ledger':rows,'syntheticOnly':data['syntheticOnly'],
            'trainingPerformed':False,'calibrationFittingPerformed':False,'independentTest':False,'releaseGatePassed':False,'activationAllowed':False,'deployable':False}


def main():
    if len(sys.argv)!=3 or sys.argv[1] not in ('evaluate','verify'): raise ValueError('arguments')
    directory=Path(sys.argv[2]);manifest=load_json(directory/'manifest.json');data=load_json(directory/'input.json')
    if data['syntheticOnly'] is not False or environment()!=manifest['pythonEnvironment'] or data['sourceHashes']!=manifest['sourceHashes']:
        raise ValueError('environment_or_sources')
    root=Path(__file__).resolve().parents[2]
    for entry in manifest['code']:
        p=(root/entry['path']).resolve()
        if not p.is_relative_to(root) or hashlib.sha256(p.read_bytes()).hexdigest()!=entry['sha256']: raise ValueError('executable_changed')
    report=evaluate(data);report['manifestSha256']=hashlib.sha256((directory/'manifest.json').read_bytes()).hexdigest()
    report['inputSha256']=hashlib.sha256((directory/'input.json').read_bytes()).hexdigest()
    if sys.argv[1]=='verify':
        if load_json(directory/'report.json')!=report: raise ValueError('report_replay')
    else:
        with (directory/'report.json').open('x',encoding='utf8',newline='\n') as f:
            json.dump(report,f,allow_nan=False,separators=(',',':'));f.write('\n')


if __name__=='__main__':
    try: main()
    except Exception:
        print('Оценка отклонена: проверьте протокол, источники, окружение и границы выборки.',file=sys.stderr);sys.exit(1)
