"""Offline-only ML bootstrap. Never use in API runtime. Training on real matches is a later task."""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import hashlib
import json
import math

FEATURES = ("elo_delta", "form_delta", "cohesion_delta", "patch_distance")
SPLITS = ("train", "calibration", "validation", "test")

class DatasetError(ValueError):
    pass

def _time(raw: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, AttributeError) as exc:
        raise DatasetError(f"Invalid ISO timestamp: {raw}") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise DatasetError("All timestamps must include timezone")
    return parsed.astimezone(timezone.utc)

def load_dataset(filename: Path, allow_synthetic: bool = False) -> tuple[list[dict[str,Any]], str, bool]:
    raw = filename.read_bytes()
    fingerprint = hashlib.sha256(raw).hexdigest()
    records = [json.loads(line) for line in raw.decode().splitlines() if line.strip()]
    if not records:
        raise DatasetError("Dataset is empty")
    ids = set()
    series_splits = {}
    split_times = {x: [] for x in SPLITS}
    synthetic = False
    for index, r in enumerate(records):
        if r.get("split") not in SPLITS:
            raise DatasetError(f"Row {index}: invalid split")
        if not isinstance(r.get("match_id"), str) or not r["match_id"].isdigit():
            raise DatasetError(f"Row {index}: noncanonical match ID")
        if r["match_id"] in ids:
            raise DatasetError(f"Duplicate match ID: {r['match_id']}")
        ids.add(r["match_id"])
        if r.get("is_pro") is not True or r.get("label_source") != "confirmed_pro_result":
            raise DatasetError("Unverified/non-pro outcome cannot be used for training")
        if type(r.get("team_a_won")) is not bool:
            raise DatasetError("Missing verified boolean label")
        start = _time(r["map_started_at"])
        cutoff = _time(r["cutoff_at"])
        feats_time = _time(r["features_observed_at"])
        verified = _time(r["label_verified_at"])
        if not feats_time <= cutoff < start <= verified:
            raise DatasetError(f"Row {index}: point-in-time leakage or unavailable label")
        split_times[r["split"]].append(start)
        series = r.get("series_id")
        if not isinstance(series, str) or not series:
            raise DatasetError("Missing series ID")
        if series in series_splits and series_splits[series] != r["split"]:
            raise DatasetError(f"Series {series} spans train and evaluation splits")
        series_splits[series] = r["split"]
        features = r.get("features")
        if not isinstance(features, dict) or set(features) != set(FEATURES):
            raise DatasetError(f"Row {index}: feature keys must match declared schema")
        for f in FEATURES:
            val = features[f]
            if val is not None and (type(val) not in (int, float) or not math.isfinite(val)):
                raise DatasetError(f"Row {index}: nonnumeric/nonfinite feature {f}")
        synthetic = synthetic or (r.get("synthetic") is True)
    if synthetic and not allow_synthetic:
        raise DatasetError("Synthetic dataset: provide --allow-synthetic for CI/demo only; never deploy")
    if any(not split_times[s] for s in SPLITS):
        raise DatasetError("All four chronological splits must be represented")
    for before, after in zip(SPLITS, SPLITS[1:]):
        if max(split_times[before]) >= min(split_times[after]):
            raise DatasetError(f"Non-chronological split boundary: {before} -> {after}")
    return records, fingerprint, synthetic

def rows(records: list[dict], split: str):
    subset = [r for r in records if r["split"] == split]
    X = [[r["features"][key] for key in FEATURES] for r in subset]
    y = [int(r["team_a_won"]) for r in subset]
    return X, y

def sigmoid(z: float) -> float:
    if z >= 0:
        return 1 / (1 + math.exp(-z))
    e = math.exp(z)
    return e / (1 + e)

def infer(model: dict, features: dict[str, float | None]) -> float:
    z = float(model["intercept"])
    for i, name in enumerate(model["feature_names"]):
        v = features[name]
        v = model["imputer_medians"][i] if v is None else v
        z += model["coefficients"][i] * ((v - model["scaler_mean"][i]) / model["scaler_scale"][i])
    logit = float(model["calibration_intercept"]) + float(model["calibration_slope"]) * z
    return sigmoid(logit)
