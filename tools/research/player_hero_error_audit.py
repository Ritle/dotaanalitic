"""Post-hoc diagnosis of frozen H1/H2 predictions. No fitting or promotion."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys

from player_hero_evaluate import VARIANTS
from post_draft_evaluate import losses

ROOT = Path(__file__).resolve().parents[2]
EVALUATION = ROOT / '.tools/s304-hero-eval-r1'
SOURCES = {
    'dataset': ROOT / '.tools/s304-hero-dataset-r1/dataset.json',
    'features': ROOT / '.tools/s304-hero-dataset-r1/features.json',
    'fitArtifact': ROOT / '.tools/s304-hero-fit-r1/artifact.json',
}


def unique(rows):
    result = {r['matchId']: r for r in rows}
    if len(result) != len(rows):
        raise ValueError('duplicate_map')
    return result


def close(actual, expected):
    if not math.isfinite(actual) or not math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-12):
        raise ValueError('numeric_reconciliation')


def summarize(rows):
    n = len(rows)
    total = math.fsum(r['deltaLogLoss'] for r in rows)
    return {
        'maps': n, 'series': len({r['seriesKey'] for r in rows}),
        'sumDeltaLogLoss': total, 'deltaLogLoss': total / n if n else None,
        'deltaBrier': math.fsum(r['deltaBrier'] for r in rows) / n if n else None,
        'improved': sum(r['deltaLogLoss'] < 0 for r in rows),
        'worsened': sum(r['deltaLogLoss'] > 0 for r in rows),
        'unchanged': sum(r['deltaLogLoss'] == 0 for r in rows),
        'h1Correct': sum(r['classification'] in ('both_correct', 'broken') for r in rows),
        'h2Correct': sum(r['classification'] in ('both_correct', 'fixed') for r in rows),
    }


def grouped(rows, key, values=()):
    groups = {v: [] for v in values}
    for r in rows:
        groups.setdefault(r[key], []).append(r)
    return [{'value': k, **summarize(v), 'matchIds': [r['matchId'] for r in v]}
            for k, v in sorted(groups.items(), key=lambda item: str(item[0]))]


def practice_summary(feature):
    if feature['status'] != 'computed_research_only' or feature['deployable'] is not False:
        raise ValueError('feature_unavailable')
    a, b = feature['teamA'], feature['teamB']
    players = a + b
    if len(a) != 5 or len(b) != 5 or len({p['accountId'] for p in players}) != 10:
        raise ValueError('invalid_lineup')
    for p in players:
        for field in ('nRaw', 'heroUnknownMaps'):
            if type(p[field]) is not int or p[field] < 0:
                raise ValueError('invalid_count')
        close(p['log1pCount'], math.log1p(p['nRaw']))
    mean_a = math.fsum(math.log1p(p['nRaw']) for p in a) / 5
    mean_b = math.fsum(math.log1p(p['nRaw']) for p in b) / 5
    close(feature['teamAMean'], mean_a)
    close(feature['teamBMean'], mean_b)
    close(feature['feature'], mean_a - mean_b)
    return {
        'practiceDelta': feature['feature'],
        'teamAMeanLogCount': mean_a, 'teamBMeanLogCount': mean_b,
        'zeroCountPlayers': sum(p['nRaw'] == 0 for p in players),
        'unknownHistoryPlayers': sum(p['heroUnknownMaps'] > 0 for p in players),
        'minimumObservedHeroCount': min(p['nRaw'] for p in players),
        'observedHeroCountsA': [p['nRaw'] for p in a],
        'observedHeroCountsB': [p['nRaw'] for p in b],
    }


def audit(report, dataset, features, artifact):
    ledger = unique(report['ledger'])
    data = unique(dataset['rows'])
    snapshots = unique(features['rows'])
    late = {k for k, r in data.items() if r['nominalWindow'] == 'development_test'}
    if late != set(ledger) or len(ledger) != report['counts']['plannedDenominator']:
        raise ValueError('denominator_changed')
    if any(d['deployable'] is not False for d in (report, dataset, features, artifact)):
        raise ValueError('research_only')
    h1, h2 = (artifact['models'][k] for k in ('H1', 'H2'))
    for model, order in ((h1, ['eloLogit']), (h2, ['eloLogit', 'observedHeroPracticeLog90Delta'])):
        if (model['status'] != 'fitted' or model['featureOrder'] != order
                or len(model['coefficients']) != len(order) or model['intercept'] != 0
                or any(not math.isfinite(v) for v in model['coefficients'])
                or model['calibration']['status'] != 'fitted'
                or not 0 < model['calibration']['temperature'] < math.inf):
            raise ValueError('unsupported_model')
    t1, t2 = h1['calibration']['temperature'], h2['calibration']['temperature']
    failed = {r['seriesKey'] for r in ledger.values() if r['pairedEligible']
              and any(r['predictions'][k] is None for k in VARIANTS)}
    rows, excluded = [], []
    for match_id in sorted(ledger, key=int):
        source, d = ledger[match_id], data[match_id]
        if any(source[k] != d[k] for k in ('seriesKey', 'startedAt', 'pairedEligible', 'baselineEligible')):
            raise ValueError('ledger_changed')
        if not source['pairedEligible'] or source['seriesKey'] in failed:
            excluded.append({**source, 'auditReasons': source['reasons'] +
                             (['SERIES_PREDICTION_UNAVAILABLE'] if source['seriesKey'] in failed else [])})
            continue
        if type(source['label']) is not bool or source['seriesKey'] is None:
            raise ValueError('invalid_target')
        snapshot = snapshots[match_id]
        if snapshot['seriesKey'] != source['seriesKey'] or snapshot['nominalWindow'] != 'development_test':
            raise ValueError('snapshot_binding')
        practice = practice_summary(snapshot['feature'])
        close(practice['practiceDelta'], d['inputs']['observedHeroPracticeLog90Delta'])
        ann = source['annotations']
        if (ann['hasUnknownHeroHistory'] is not (practice['unknownHistoryPlayers'] > 0)
                or ann['hasZeroObservedHeroCount'] is not (practice['zeroCountPlayers'] > 0)):
            raise ValueError('missingness_changed')
        elo = d['inputs']['eloLogit']
        hero_raw = practice['practiceDelta'] * h2['coefficients'][1]
        expected = {'H0': elo, 'H1_raw': elo*h1['coefficients'][0],
                    'H1_cal': elo*h1['coefficients'][0]/t1,
                    'H2_raw': elo*h2['coefficients'][0]+hero_raw,
                    'H2_cal': (elo*h2['coefficients'][0]+hero_raw)/t2}
        ps = source['predictions']
        for key, value in expected.items():
            close(ps[key]['logit'], value)
            prob = 1/(1+math.exp(-value)) if value >= 0 else math.exp(value)/(1+math.exp(value))
            close(ps[key]['probability'], prob)
        correct1 = (ps['H1_cal']['probability'] >= .5) == source['label']
        correct2 = (ps['H2_cal']['probability'] >= .5) == source['label']
        classification = ('both_correct' if correct1 and correct2 else 'both_wrong' if not correct1 and not correct2
                          else 'fixed' if correct2 else 'broken')
        ll1, br1 = losses(source, 'H1_cal')
        ll2, br2 = losses(source, 'H2_cal')
        rows.append({
            'matchId': match_id, 'seriesKey': source['seriesKey'], 'startedAt': source['startedAt'],
            **ann, **practice, 'label': source['label'], 'classification': classification,
            'h1Probability': ps['H1_cal']['probability'], 'h2Probability': ps['H2_cal']['probability'],
            'h1LogLoss': ll1, 'h2LogLoss': ll2, 'deltaLogLoss': ll2-ll1, 'deltaBrier': br2-br1,
            'h2PracticeLogit': hero_raw/t2, 'h2EloLogit': elo*h2['coefficients'][0]/t2,
            'eloSlopeChangeLogit': elo*(h2['coefficients'][0]/t2-h1['coefficients'][0]/t1),
        })
    if len(rows) != report['counts']['pairedMaps']:
        raise ValueError('paired_count_changed')
    totals = summarize(rows)
    if rows:
        close(totals['deltaLogLoss'], report['bootstrap']['deltas']['logLoss_H2_cal_minus_H1_cal']['mean'])
        close(totals['deltaBrier'], report['pairedMetrics']['H2_cal']['brier']-report['pairedMetrics']['H1_cal']['brier'])
        if (totals['h1Correct'] != report['pairedMetrics']['H1_cal']['correct']
                or totals['h2Correct'] != report['pairedMetrics']['H2_cal']['correct']):
            raise ValueError('classification_reconciliation')
    return {
        'format': 'player-hero-error-audit-v1', 'basis': 'post_hoc_exposed_development_diagnostics',
        'counts': {'planned': len(ledger), 'paired': len(rows), 'excluded': len(excluded)},
        'totals': totals, 'classification': grouped(rows, 'classification', ('both_correct', 'both_wrong', 'fixed', 'broken')),
        'strata': {key: grouped(rows, key, (False, True) if key.startswith('has') else ())
                   for key in ('hasZeroObservedHeroCount', 'hasUnknownHeroHistory', 'zeroCountPlayers',
                               'unknownHistoryPlayers', 'leagueId', 'monthUTC', 'provider', 'providerPatchId', 'canonicalPatchId')},
        'bySeries': grouped(rows, 'seriesKey'), 'rows': rows, 'excluded': excluded,
        'lossRanking': [r['matchId'] for r in sorted(rows, key=lambda r: (-r['deltaLogLoss'], int(r['matchId'])))],
        'originalDecision': report['decision'], 'originalPrimaryInterval': report['bootstrap']['deltas']['logLoss_H2_cal_minus_H1_cal'],
        'trainingPerformed': False, 'calibrationFittingPerformed': False, 'thresholdSelectionPerformed': False,
        'independentTest': False, 'releaseGatePassed': False, 'activationAllowed': False,
        'deployable': False, 'causalAttribution': False,
    }


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    if path.stat().st_size > 128*1024*1024:
        raise ValueError('oversize_input')
    return json.loads(path.read_text(encoding='utf-8'))


def write_or_verify(output, path, verify):
    if verify:
        if load(path) != output:
            raise ValueError('audit_replay')
    else:
        with path.open('x', encoding='utf-8', newline='\n') as handle:
            json.dump(output, handle, ensure_ascii=False, allow_nan=False, indent=2)
            handle.write('\n')


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ('audit', 'verify'):
        raise ValueError('arguments')
    out = Path(sys.argv[2]).resolve()
    if not out.is_relative_to(ROOT / '.tools'):
        raise ValueError('output_outside_tools')
    # Existing replay binds source bytes, fixed TS inference, labels, full series,
    # policy, environment and the original negative result. Never invokes fit.
    subprocess.run(['node', str(ROOT/'tools/research/player-hero-evaluate.mjs'), 'verify', str(EVALUATION)],
                   cwd=ROOT, check=True, timeout=180, capture_output=True)
    report = load(EVALUATION / 'report.json')
    for key, path in SOURCES.items():
        if sha(path) != report['sourceHashes'][key]:
            raise ValueError('source_binding')
    output = audit(report, *(load(SOURCES[k]) for k in ('dataset', 'features', 'fitArtifact')))
    output['sourceHashes'] = {**report['sourceHashes'],
                             **{k: sha(EVALUATION/f'{k}.json') for k in ('manifest', 'input', 'report', 'result')}}
    output['auditCodeSha256'] = sha(Path(__file__))
    write_or_verify(output, out, sys.argv[1] == 'verify')
    print('Player-hero error audit PASS; training=0 activation=0')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Аудит не выполнен: проверьте источники, SHA и отдельный путь результата.', file=sys.stderr)
        sys.exit(1)
