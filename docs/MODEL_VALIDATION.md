# ML QA — непрерывное обучение и выпуск прогнозов

## Жёсткие инварианты P0

1. Target = победа **на карте**; подтверждённая про-карта и актуальная ориентация Team A/Team B. User guess/model prediction не являются меткой.
2. Ас-of cutoff строго до карты. Входы должны быть известны **до** cutoff, не задним числом из завершившейся карты.
3. Раздельные chronological `train`, `calibration`, `validation`, `test`. В пределах одной серии все карты остаются в одном split. Прогноз pre-map2 должен отличаться от pre-series.
4. Честный patch cold-start: если данных нет, ответ `unavailable`, а не самодельные 50/50.
5. Отдельно оценивать pre-match и post-draft и прирост качества последних на одинаковых картинах. Brier/LogLoss, calibration, coverage, stratified patches/stand-ins/side.
6. Датасеты frozen с SHA, feature-schema/code revision, list of match IDs; дополнительные реальные результаты приводят к **новой версии**.
7. Candidate model `deployable:false` пока отдельный promotion-gate не проверен. Автоактивация моделей отключена по умолчанию.

## Что действительно реализовано в v7

`tools/ml/pipeline.py` валидирует confirmed pro labels, ts cutoffs, split chronology, series separation, feature schema, уникальность карт. `train.py` обучает logistic + отдельную калибровку и сохраняет JSON candidate, `evaluate.py` и `scripts/check-ml-parity.mjs` проверяют исходящий артефакт. Golden файл `tests/golden/synthetic-logistic-candidate.json` создан на синтетике и **никогда** не используется для реальных прогнозов.

## Чего ещё нет (S3)

- Исторический feature builder из PostgreSQL, as-of snapshots для реальных данных, верификация персональных аккаунтов и составов.
- Production min sample/acceptance thresholds и автоматическая проверка model promotion / champion-challenger на данных матчей.
- Переобучение на реальных исходах, stable inference endpoint и scoring history. Подготовленный loader — не опубликованная модель.

## Операция воспроизведения synthetic baseline

```bash
python -m pip install -r tools/ml/requirements-ci.txt
python -m pip install --no-deps -e tools/ml
PYTHONPATH=tools/ml python -m pytest tools/ml/tests -q
python tools/ml/train.py --dataset tests/fixtures/ml/synthetic_history.jsonl --output /tmp/demo-dota.json --allow-synthetic
python tools/ml/evaluate.py /tmp/demo-dota.json
node scripts/check-ml-parity.mjs /tmp/demo-dota.json
```
