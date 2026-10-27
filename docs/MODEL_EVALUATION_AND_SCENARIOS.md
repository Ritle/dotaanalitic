# Model Evaluation, What-if & Prediction History

## P0 — scope оценок

Модель предсказывает **одну карту**: до драфта и после назначения десяти героев. Pre/draft имеют самостоятельные версии, общую pipeline сборку исторических as-of признаков и строгую проверку calibration. Валидация: chronological train/calibration/holdout, grouping по серии (запрет разрыва), source/patch/roster drift assessment.

Отчёт: Brier score, Log Loss, ECE / reliability, hit rate (вторична), sample size по тесту, confidence intervals для срезов по возможности, сравнимый Elo baseline. Для post-draft используйте **тот же поднабор holdout**, что и для pre-match. Используйте out-of-fold pre score как вход на train для postdraft, не итог training-fit score.

### Ablation plan

1. Naive/rolling win rate / Elo organization-only.
2. `+ opponent-adjusted strength`, transfer-safe players.
3. `+ exact roster, pairs, stand-ins, role stability`.
4. `+ patch/time weighting`, changes/reworks.
5. `+ hero/player×hero`, directed matchup, allied synergy.
6. (P1) `+ LAN/online, tier/stage, first-pick draft order`, проверять прирост отдельно, не включать просто потому что фактор выглядит важным.

Отдельные срезы: fresh major patch, few games, roster substitution, unknown identity, pre-known vs hindsight-assumed lineups, Radiant/Dire, new opponent, tournament tier. Не переоптимизировать на holdout. Критерии включения вероятности — `docs/PREDICTION_ENGINE.md`.

## P1 — actual outcome + performance UI

`prediction_runs` — immutable снимок прогноза на дату T. После карты вручную или по подтверждённой связке `prediction_outcomes` добавляет **отдельную** запись факта; old input/features/probability не редактируются. Страница Model Performance позволяет смотреть Brier/log loss/calibration по патчам, времени, смене состава и на текущей модели, не на тренировочных примерах.

Сравнение pre/post только при same scenario revision/cutoff/lineup/context, иначе `deltaPercentagePoints=null`. Пользователь должен видеть окно истории, реальных героев, роли, сторону и known/unknown, иначе сравнение вводит в заблуждение. Изменение прогноза ≠ доказанный причинный эффект драфта.

## P1 — What-if Analysis

Копирование scenario в `parent_scenario_id`, изменение одной или нескольких переменных (сторона, stand-in, роли, драфт). Исходный snapshot остаётся неизменным, новая версия содержит явную гипотезу и отдельную вероятность только после действующего model quality gate. При несопоставимом контексте/patch или неготовой модели выводить unavailable, а не мнимую delta.

## P2 — series win / between maps

Предсказывать BO1/BO2/BO3/BO5 только после разработки отдельной target definition и валидации. Если серия BO2 допускает ничью — не сводить исход автоматически к бинарному winner. Между картами использовать только уже известные до старта следующей карты результаты, не будущее расписание исходов. Это **не входит** в personal MVP.

## v4: отличать training labels, retrospective и live-feedback

Связанный архитектурный контракт `docs/CONTINUOUS_LEARNING_PIPELINE.md`. Verify outcome via pro-map, not a user's predicted favorite. Каждая карта единожды появляется в **конкретной версии обучающего датасета** независимо от числа сохранённых прогнозов. Повторные попытки/коррекции тренировки создают независимые versioned datasets и candidates, а не изменяют старый holdout. Historical test и prospective live-monitoring должны отображаться раздельно, иначе пользователь может ошибочно принять тренировочную точность за фактическую. Candidate активируется только после gate и атомарной проверки версии действующей модели; rollback документируется в `model_activation_events`.
