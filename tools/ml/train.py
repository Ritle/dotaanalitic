"""Bootstrapped baseline. Candidate artifacts are NEVER activated by this script."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss
from pipeline import FEATURES, load_dataset, rows, infer, DatasetError

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--allow-synthetic', action='store_true', help='ONLY for development fixtures')
    args = parser.parse_args()
    records, fingerprint, synthetic = load_dataset(args.dataset, args.allow_synthetic)
    X_train,y_train=rows(records,'train')
    if len(X_train)<20 or len(set(y_train))<2:
        raise DatasetError('Need at least 20 training rows and both outcomes')
    imp=SimpleImputer(strategy='median')
    normalized_train=imp.fit_transform(X_train)
    if normalized_train.shape[1]!=len(FEATURES):
        raise DatasetError('All feature columns must have observed numeric values')
    scale=StandardScaler()
    scaled_train=scale.fit_transform(normalized_train)
    model=LogisticRegression(max_iter=1000, C=1.0,random_state=17,solver='lbfgs')
    model.fit(scaled_train,y_train)
    # Independent calibration period (kept disjoint from training, validation, and test).
    X_cal,y_cal=rows(records,'calibration')
    if len(X_cal)<6 or len(set(y_cal))<2:
        raise DatasetError('Insufficient calibration data')
    logits=model.decision_function(scale.transform(imp.transform(X_cal))).reshape(-1,1)
    calibration=LogisticRegression(max_iter=1000, C=100.0,random_state=17,solver='lbfgs')
    calibration.fit(logits,y_cal)
    artifact={
        'format':'dota2-logistic-v1','feature_names':list(FEATURES),'dataset_sha256':fingerprint,
        'scikit_learn_version':__import__('sklearn').__version__,
        'synthetic_only':bool(synthetic), 'deployable':False,
        'imputer_medians':imp.statistics_.astype(float).tolist(),
        'scaler_mean':scale.mean_.astype(float).tolist(),
        'scaler_scale':scale.scale_.astype(float).tolist(),
        'intercept':float(model.intercept_[0]),
        'coefficients':model.coef_[0].astype(float).tolist(),
        'calibration_intercept':float(calibration.intercept_[0]),
        'calibration_slope':float(calibration.coef_[0][0]),
        'metrics':{},'reference_predictions':[]
    }
    # These are sample metrics, NOT a pass/fail release gate; no autopromotion in this script.
    for split in ('train','calibration','validation','test'):
        subset=[r for r in records if r['split']==split]
        y=[int(r['team_a_won']) for r in subset]
        pred=[infer(artifact,r['features']) for r in subset]
        artifact['metrics'][split]={'n':len(y),'brier':float(brier_score_loss(y,pred)),
                                    'log_loss':float(log_loss(y,pred,labels=[0,1]))}
    artifact['reference_predictions']=[
        {'match_id':r['match_id'], 'features':r['features'], 'probability':infer(artifact,r['features'])}
        for r in records if r['split']=='test'
    ][:12]
    args.output.parent.mkdir(parents=True,exist_ok=True)
    if args.output.exists():
        raise FileExistsError('Refusing to overwrite an existing model artifact')
    args.output.write_text(json.dumps(artifact,indent=2,sort_keys=True)+'\n')
    print(json.dumps({'artifact':str(args.output),'dataset_sha256':fingerprint,'synthetic_only':synthetic,
                      'deployable':False, 'metrics':artifact['metrics']},indent=2))

if __name__=='__main__':
    main()
