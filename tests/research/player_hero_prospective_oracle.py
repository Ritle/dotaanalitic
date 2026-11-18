"""Independent synthetic-only arithmetic oracle. No fitting or production output."""
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def check():
    artifact_bytes = (ROOT / '.tools/s304-hero-fit-r1/artifact.json').read_bytes()
    assert hashlib.sha256(artifact_bytes).hexdigest() == '9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b'
    models = json.loads(artifact_bytes)['models']
    cases = json.loads((ROOT / '.tools/s304-prospective-feature-parity-cases.json').read_bytes())
    checks = 0
    max_error = 0.0
    def close(actual, expected):
        nonlocal checks, max_error
        error = abs(actual - expected)
        assert error < 1e-12, (actual, expected)
        checks += 1
        max_error = max(max_error, error)
    for case in cases:
        data, result = case['input'], case['result']
        assert data['history']['syntheticOnly'] and data['capture']['syntheticOnly']
        cutoff = int(data['capture']['decisionCutoffAtUs'])
        scenario = data['capture']['input']['scenario']
        observations = {o['matchId']: o for o in data['outcomeObservations']}
        bad_series = set()
        for m in data['history']['maps']:
            o = observations[m['matchId']]
            if any(o[k] is not None and int(o[k]) >= cutoff for k in ['sourceKnownAtUs','fetchedAtUs','observedAtUs','recordedAtUs']):
                bad_series.add(m['seriesKey'])
        maps = [m for m in data['history']['maps'] if m['seriesKey'] not in bad_series]
        assert result['eloSnapshot']['coverage']['nRaw'] == len(maps)
        ratings, counts, pending = {}, {}, {}
        # Start events precede completion events at an identical microsecond.
        events = sorted((int(m[field]), phase, int(m['matchId']), m)
                        for m in maps for field, phase in [('startedAtUs',0),('completedAtUs',1)])
        def mean_rating(side):
            return sum(ratings.get(p['playerId'], 1500.0) for p in sorted(side,key=lambda p:int(p['playerId']))) / 5
        for _, phase, _, m in events:
            if phase == 0:
                expectation = 1 / (1 + 10 ** ((mean_rating(m['teamB']) - mean_rating(m['teamA'])) / 400))
                pending[m['matchId']] = 32 * (int(m['teamAWon']) - expectation)
            else:
                for side, sign in [('teamA',1),('teamB',-1)]:
                    for p in m[side]:
                        key = p['playerId']
                        ratings[key] = ratings.get(key,1500.0) + sign * pending[m['matchId']]
                        counts[key] = counts.get(key,0) + 1
        for side in ['teamA','teamB']:
            for p in result['eloSnapshot'][side]:
                close(p['rating'], ratings[p['playerId']])
                assert p['maps'] == counts[p['playerId']]
        ready = all(counts.get(p['playerId'],0) >= 5 for side in ['teamA','teamB'] for p in scenario[side])
        assert (result['inputs'] is not None) == ready
        if not ready:
            assert result['encoded'] is None and case['researchOnlyScores'] is None
            continue
        elo = math.log(10)*(mean_rating(scenario['teamA'])-mean_rating(scenario['teamB']))/400
        def practice(side):
            total = 0.0
            for p in side:
                count = sum(any(h['playerId']==p['playerId'] and h['accountId']==p['accountId'] and h['heroId']==p['heroId'] for h in m['players'])
                            for m in data['capture']['input']['history']['maps']
                            if cutoff-90*86400000000 <= int(m['startedAtUs']) < cutoff and int(m['completedAtUs']) < cutoff)
                total += math.log1p(count)
            return total / 5
        hero = practice(scenario['teamA'])-practice(scenario['teamB'])
        close(result['inputs']['eloLogit'],elo)
        close(result['inputs']['observedHeroPracticeLog90Delta'],hero)
        assert result['encoded']['H1'] == [result['inputs']['eloLogit']]
        for name in ['H1','H2']:
            model = models[name]
            value = sum(a*b for a,b in zip([elo,hero],model['coefficients']))
            for field, divisor in [('rawProbability',1),('calibratedProbability',model['calibration']['temperature'])]:
                close(case['researchOnlyScores'][name][field],1/(1+math.exp(-value/divisor)))
        assert not result['deployable'] and not result['primaryEligible']
    print(json.dumps({'status':'passed','syntheticOnly':True,'cases':len(cases),'numericChecks':checks,'maxAbsoluteError':max_error,'trainingPerformed':False}))

if __name__ == '__main__':
    check()
