"""History-only R2: frozen-parameter scores, exact common-map comparison, no fitting."""
from __future__ import annotations
import hashlib
import json
import sys
from pathlib import Path
import numpy as np
import post_draft_evaluate as base
from post_draft_fit import environment, load_json


def paired(rows):
    return [r for r in rows if r['pairedEligible'] and all(r['predictions'][k] is not None for k in base.VARIANTS)]


def paired_revision_deltas(previous, current, policy):
    if [r['matchId'] for r in previous] != [r['matchId'] for r in current]:
        raise ValueError('common_ids_not_aligned')
    groups = {}
    for old, new in zip(previous, current):
        if any(old[k] != new[k] for k in ('seriesKey', 'startedAt', 'label')):
            raise ValueError('common_target_changed')
        values = []
        for name in base.VARIANTS:
            before, after = base.losses(old, name), base.losses(new, name)
            values.extend([after[0] - before[0], after[1] - before[1]])
        groups.setdefault(new['seriesKey'], []).append(values)
    result = {'maps': len(current), 'series': len(groups), 'unit': 'whole_series', 'direction': 'R2_minus_R1',
              'replicates': policy['replicates'], 'seed': policy['seed'], 'rng': 'numpy.PCG64',
              'interval': 'exploratory_percentile95_linear', 'drawSha256': None, 'models': {}}
    if groups:
        blocks = [np.asarray(groups[k]) for k in sorted(groups)]
        sums, sizes = np.asarray([b.sum(axis=0) for b in blocks]), np.asarray([len(b) for b in blocks])
        draws = base.block_draws(len(blocks), policy['replicates'], policy['seed'])
        sampled = sums[draws].sum(axis=1) / sizes[draws].sum(axis=1)[:, None]
        limits = np.quantile(sampled, [.025, .975], axis=0, method='linear')
        means = sums.sum(axis=0) / sizes.sum()
        result['drawSha256'] = hashlib.sha256(draws.astype('<u4').tobytes()).hexdigest()
    for i, name in enumerate(base.VARIANTS):
        old_metrics, new_metrics = base.metrics(previous, name), base.metrics(current, name)
        result['models'][name] = {
            metric: {'mean': float(means[2*i+j]) if groups else None,
                     'lower': float(limits[0, 2*i+j]) if groups else None,
                     'upper': float(limits[1, 2*i+j]) if groups else None}
            for j, metric in enumerate(('logLoss', 'brier'))}
        for metric in ('accuracy', 'ece'):
            result['models'][name][metric + 'Delta'] = new_metrics[metric] - old_metrics[metric] if groups else None
    return result


def evaluate(bundle):
    if set(bundle) != {'format', 'current', 'previous'} or bundle['format'] != 'post-draft-r2-evaluation-input-v1':
        raise ValueError('bundle_fields')
    previous, current = base.validate(bundle['previous']), base.validate(bundle['current'])
    old_all, new_all = ({r['matchId']: r for r in rows} for rows in (previous, current))
    if set(old_all) != set(new_all) or bundle['previous']['plannedDenominator'] != bundle['current']['plannedDenominator']:
        raise ValueError('target_denominator_changed')
    for key, old in old_all.items():
        new = new_all[key]
        if any(old[k] != new[k] for k in ('seriesKey', 'startedAt')) or old['label'] is not None and old['label'] != new['label']:
            raise ValueError('target_identity_or_label_changed')
    old_scores, new_scores = ({r['matchId']: r for r in paired(rows)} for rows in (previous, current))
    common_ids = sorted(set(old_scores) & set(new_scores), key=int)
    recovered_ids = sorted(set(new_scores) - set(old_scores), key=int)
    lost_ids = sorted(set(old_scores) - set(new_scores), key=int)
    old_common, new_common = [old_scores[k] for k in common_ids], [new_scores[k] for k in common_ids]
    recovered, lost = [new_scores[k] for k in recovered_ids], [old_scores[k] for k in lost_ids]
    return {'format': 'post-draft-r2-evaluation-report-v1', 'basis': 'previously_exposed_history_sensitivity_not_independent',
            'overall': base.evaluate(bundle['current']),
            'common': {'mapIds': common_ids, 'R1': {k: base.metrics(old_common, k) for k in base.VARIANTS},
                       'R2': {k: base.metrics(new_common, k) for k in base.VARIANTS},
                       'deltas': paired_revision_deltas(old_common, new_common, bundle['current']['policy']['evaluation']['bootstrap'])},
            'recovered': {'mapIds': recovered_ids, 'metrics': {k: base.metrics(recovered, k) for k in base.VARIANTS},
                          'interpretation': 'selected_by_history_coverage; small subgroup, no independent quality claim'},
            'lost': {'mapIds': lost_ids, 'R1Metrics': {k: base.metrics(lost, k) for k in base.VARIANTS}},
            'trainingPerformed': False, 'calibrationFittingPerformed': False, 'independentTest': False,
            'releaseGatePassed': False, 'activationAllowed': False, 'deployable': False}


def main():
    if len(sys.argv) != 5 or sys.argv[1] not in ('evaluate', 'verify'):
        raise ValueError('arguments')
    input_path, manifest_path, output_path = map(Path, sys.argv[2:])
    data, manifest = load_json(input_path), load_json(manifest_path)
    if any(data[k]['syntheticOnly'] is not False for k in ('current', 'previous')) or environment() != manifest['pythonEnvironment']:
        raise ValueError('synthetic_or_environment')
    if data['current']['sourceHashes'] != manifest['sourceHashes'] or data['previous']['sourceHashes'] != manifest['previousSourceHashes']:
        raise ValueError('source_lineage')
    root = Path(__file__).resolve().parents[2]
    for entry in manifest['code']:
        p = (root / entry['path']).resolve()
        if not p.is_relative_to(root) or hashlib.sha256(p.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError('executable_changed')
    report = evaluate(data)
    report['manifestSha256'] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    report['inputSha256'] = hashlib.sha256(input_path.read_bytes()).hexdigest()
    if sys.argv[1] == 'verify':
        if load_json(output_path) != report:
            raise ValueError('report_replay_mismatch')
    else:
        with output_path.open('x', encoding='utf-8', newline='\n') as f:
            json.dump(report, f, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
            f.write('\n')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Оценка R2 отклонена: проверьте исходные карты, manifest, SHA и окружение.', file=sys.stderr)
        sys.exit(1)
