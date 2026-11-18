"""Diagnostic replay of an already exposed evaluation; never fits or promotes models."""
from __future__ import annotations
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import sys
from post_draft_evaluate import evaluate, losses, metrics, VARIANTS

ROOT = Path(__file__).resolve().parents[2]


def unique(rows):
    result = {r['matchId']: r for r in rows}
    if len(result) != len(rows):
        raise ValueError('duplicate_map')
    return result


def summarize(rows):
    n = len(rows)
    return {'maps': n, 'series': len({r['seriesKey'] for r in rows}),
            'deltaLogLoss': sum(r['deltaLogLoss'] for r in rows) / n if n else None,
            'deltaBrier': sum(r['deltaBrier'] for r in rows) / n if n else None,
            'sumDeltaLogLoss': sum(r['deltaLogLoss'] for r in rows)}


def grouped(rows, key):
    groups = defaultdict(list)
    for row in rows:
        groups[str(row[key]) if row[key] is not None else 'unknown'].append(row)
    return [{'value': k, **summarize(v)} for k, v in sorted(groups.items())]


def audit(report, dataset, artifact):
    ledger = report['ledger']
    unique(ledger)
    by_dataset = unique(dataset['rows'])
    late = {r['matchId'] for r in dataset['rows'] if r['nominalWindow'] == 'development_test'}
    if late != {r['matchId'] for r in ledger} or len(ledger) != report['counts']['plannedDenominator']:
        raise ValueError('denominator_changed')
    if dataset['deployable'] is not False or artifact['deployable'] is not False:
        raise ValueError('research_only')
    vocab = artifact['heroVocabulary']
    if len(vocab) != len(set(vocab)) or vocab != dataset['heroVocabulary']:
        raise ValueError('vocabulary_changed')
    m1, m2 = (artifact['models'][k] for k in ('M1', 'M2'))
    for model, size in [(m1, 1), (m2, len(vocab) + 1)]:
        if model['status'] != 'fitted' or len(model['coefficients']) != size or model['intercept'] != 0:
            raise ValueError('unsupported_model')
        if model['calibration']['status'] != 'fitted' or model['calibration']['temperature'] <= 0:
            raise ValueError('unsupported_calibration')
    hero_coef = dict(zip(vocab, m2['coefficients'][1:]))
    train_counts = Counter(h['heroId'] for r in dataset['rows'] if r['partition'] == 'train' and r['pairedEligible']
                           for h in r['inputs']['signedHeroes'])
    rows, excluded, combinations = [], [], Counter()
    for source in sorted(ledger, key=lambda r: int(r['matchId'])):
        d = by_dataset[source['matchId']]
        if (source['reasons'] != d['reasons'] or source['pairedEligible'] != d['pairedEligible']
                or source['baselineEligible'] != d['baselineEligible']):
            raise ValueError('ledger_changed')
        if not source['pairedEligible'] or any(source['predictions'][k] is None for k in VARIANTS):
            reasons = source['reasons'] or ['PAIRED_PREDICTIONS_UNAVAILABLE']
            combinations[tuple(sorted(reasons))] += 1
            excluded.append({'matchId': source['matchId'], 'seriesKey': source['seriesKey'], 'reasons': reasons,
                             'ownFailure': any(not r.startswith('SERIES_HAS_') for r in reasons),
                             'featureSnapshotAvailable': d['featureSnapshot'] is not None})
            continue
        inputs, ps = d['inputs'], source['predictions']
        heroes = inputs['signedHeroes']
        if len(heroes) != 10 or len({h['heroId'] for h in heroes}) != 10 or sorted(h['value'] for h in heroes) != [-1]*5+[1]*5:
            raise ValueError('invalid_heroes')
        elo, t1, t2 = inputs['eloLogit'], m1['calibration']['temperature'], m2['calibration']['temperature']
        hero_term = sum(hero_coef[h['heroId']] * h['value'] for h in heroes)
        expected = {'M0': elo, 'M1_raw': elo*m1['coefficients'][0], 'M1_cal': elo*m1['coefficients'][0]/t1,
                    'M2_raw': elo*m2['coefficients'][0]+hero_term,
                    'M2_cal': (elo*m2['coefficients'][0]+hero_term)/t2}
        if any(not math.isclose(ps[k]['logit'], v, rel_tol=1e-12, abs_tol=1e-12) for k, v in expected.items()):
            raise ValueError('logit_decomposition_mismatch')
        correct1 = (ps['M1_cal']['probability'] >= .5) == source['label']
        correct2 = (ps['M2_cal']['probability'] >= .5) == source['label']
        ll1, br1 = losses(source, 'M1_cal')
        ll2, br2 = losses(source, 'M2_cal')
        outcome = 'both_correct' if correct1 and correct2 else 'both_wrong' if not correct1 and not correct2 else 'fixed' if correct2 else 'broken'
        rows.append({'matchId': source['matchId'], 'seriesKey': source['seriesKey'], **source['annotations'],
                     'deltaLogLoss': ll2-ll1, 'deltaBrier': br2-br1, 'classification': outcome,
                     'm1Probability': ps['M1_cal']['probability'], 'm2Probability': ps['M2_cal']['probability'],
                     'label': source['label'], 'm2EloLogit': elo*m2['coefficients'][0]/t2,
                     'm2HeroLogit': hero_term/t2,
                     'eloSlopeChangeLogit': elo*(m2['coefficients'][0]/t2-m1['coefficients'][0]/t1),
                     'minimumHeroTrainingMaps': min(train_counts[h['heroId']] for h in heroes)})
    if len(rows) != report['counts']['pairedMaps']:
        raise ValueError('paired_count_changed')
    totals = summarize(rows)
    if rows and not math.isclose(totals['deltaLogLoss'], report['bootstrap']['deltas']['logLoss_M2_cal_minus_M1_cal']['mean'], abs_tol=1e-12):
        raise ValueError('metric_reconciliation')
    # Retain all rows/strata. Ranking is navigation for diagnosis, never an exclusion policy.
    return {'format': 'post-draft-error-audit-v1', 'scope': 'post_hoc_exposed_development_diagnostics',
            'counts': {'planned': len(ledger), 'paired': len(rows), 'excluded': len(excluded)},
            'totals': totals, 'classification': grouped(rows, 'classification'),
            'byLeague': grouped(rows, 'leagueId'), 'byMonth': grouped(rows, 'monthUTC'),
            'bySeries': grouped(rows, 'seriesKey'),
            'exclusionCombinations': [{'reasons': list(k), 'maps': v} for k, v in sorted(combinations.items())],
            'excluded': excluded, 'siblingOnlyExclusions': sum(not r['ownFailure'] for r in excluded),
            'rows': rows, 'lossRanking': [r['matchId'] for r in sorted(rows, key=lambda r: (-r['deltaLogLoss'], int(r['matchId'])))],
            'heroTrainingExposure': [{'heroId': h, 'maps': train_counts[h]} for h in vocab],
            'slopes': {'M1RawElo': m1['coefficients'][0], 'M2RawElo': m2['coefficients'][0],
                       'M1CalibratedElo': m1['coefficients'][0]/m1['calibration']['temperature'],
                       'M2CalibratedElo': m2['coefficients'][0]/m2['calibration']['temperature'],
                       'M2TemperatureMultiplier': 1/m2['calibration']['temperature']},
            'originalDecision': report['decision'], 'trainingPerformed': False, 'deployable': False,
            'activationAllowed': False, 'causalAttribution': False}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    if path.stat().st_size > 128*1024*1024:
        raise ValueError('oversize_input')
    return json.loads(path.read_text(encoding='utf-8'))


def main():
    if len(sys.argv) != 6 or sys.argv[1] not in ('audit', 'verify'):
        raise ValueError('arguments')
    mode = sys.argv[1]
    directory, dataset_path, artifact_path, out = (Path(x).resolve() for x in sys.argv[2:])
    if not out.is_relative_to(ROOT / '.tools'):
        raise ValueError('output_outside_tools')
    result, report, inputs = (load(directory / x) for x in ('result.json', 'report.json', 'input.json'))
    manifest = load(directory / 'manifest.json')
    if (sha(directory/'report.json') != result['reportSha256'] or sha(directory/'manifest.json') != result['manifestSha256']
            or report['manifestSha256'] != result['manifestSha256'] or report['inputSha256'] != sha(directory/'input.json')
            or sha(dataset_path) != report['sourceHashes']['dataset'] or sha(artifact_path) != report['sourceHashes']['fitArtifact']
            or inputs['sourceHashes'] != manifest['sourceHashes'] or inputs['syntheticOnly'] is not False):
        raise ValueError('source_binding')
    for entry in manifest['code']:
        path = (ROOT / entry['path']).resolve()
        if not path.is_relative_to(ROOT) or sha(path) != entry['sha256']:
            raise ValueError('frozen_code_changed')
    replay = evaluate(inputs)
    if any(report.get(k) != v for k, v in replay.items()):
        raise ValueError('report_replay')
    output = audit(report, load(dataset_path), load(artifact_path))
    output['sourceHashes'] = {**report['sourceHashes'], 'report': sha(directory/'report.json'), 'input': sha(directory/'input.json')}
    output['auditCodeSha256'] = sha(Path(__file__))
    if mode == 'verify':
        if load(out) != output:
            raise ValueError('audit_replay')
    else:
        with out.open('x', encoding='utf-8', newline='\n') as handle:
            json.dump(output, handle, ensure_ascii=False, allow_nan=False, indent=2)
            handle.write('\n')
    print('Diagnostic audit PASS; training=0 activation=0')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Аудит не выполнен: проверьте источники, SHA и отдельный путь результата.', file=sys.stderr)
        sys.exit(1)
