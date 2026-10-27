"""Check saved immutable candidate against its own reference test predictions."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from pipeline import infer

parser=argparse.ArgumentParser()
parser.add_argument('artifact',type=Path)
args=parser.parse_args()
m=json.loads(args.artifact.read_text())
if m.get('format')!='dota2-logistic-v1' or m.get('deployable') is not False:
    raise SystemExit('Unknown or improperly marked candidate artifact')
for p in m['reference_predictions']:
    actual=infer(m,p['features'])
    if abs(actual-p['probability'])>1e-12: raise SystemExit(f"Parity mismatch {p['match_id']}")
print('Python saved-artifact parity PASS; candidate is not deployed')
