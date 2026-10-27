from datetime import datetime, timezone, timedelta
from pathlib import Path
import json
import pytest
from pipeline import load_dataset, DatasetError, sigmoid

FIXTURE = Path(__file__).resolve().parents[3] / 'tests/fixtures/ml/synthetic_history.jsonl'

def test_synthetic_requires_explicit_opt_in():
    with pytest.raises(DatasetError,match='Synthetic'):
        load_dataset(FIXTURE)

def test_splits_and_labels_pass_synthetic_opt_in():
    rows, sha, synthetic = load_dataset(FIXTURE, allow_synthetic=True)
    assert len(rows) >= 60
    assert len(sha) == 64 and synthetic
    assert {r['split'] for r in rows} == {'train','calibration','validation','test'}

def test_future_features_rejected(tmp_path):
    rows, *_ = load_dataset(FIXTURE,allow_synthetic=True)
    rows[0]['features_observed_at']='2099-01-01T00:00:00Z'
    p=tmp_path/'leak.jsonl'
    p.write_text('\n'.join(map(json.dumps,rows)))
    with pytest.raises(DatasetError,match='point-in-time leakage'):
        load_dataset(p,allow_synthetic=True)

def test_duplicate_map_rejected(tmp_path):
    rows,*_=load_dataset(FIXTURE,allow_synthetic=True)
    rows[1]['match_id']=rows[0]['match_id']
    p=tmp_path/'duplicate.jsonl'; p.write_text('\n'.join(map(json.dumps,rows)))
    with pytest.raises(DatasetError,match='Duplicate match ID'):
        load_dataset(p,allow_synthetic=True)

def test_cross_split_series_rejected(tmp_path):
    rows,*_=load_dataset(FIXTURE,allow_synthetic=True)
    rows[-1]['series_id']=rows[0]['series_id']
    p=tmp_path/'series.jsonl'; p.write_text('\n'.join(map(json.dumps,rows)))
    with pytest.raises(DatasetError,match='spans train'):
        load_dataset(p,allow_synthetic=True)

def test_sigmoid_stable():
    assert sigmoid(10000)==1
    assert sigmoid(-10000)==0
