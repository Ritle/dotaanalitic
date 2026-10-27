# Prediction Engine — источники, обучающие поля и аудит пригодности данных (v8)

**Статус:** проверен контракт публичных API и опубликованных источников; **эмпирические доли заполнения полей на актуальных pro-картах ещё не измерены**. Не выдавать этот документ за проведённый live benchmark. Завершить `S0-08` на сетевом компьютере до массового импорта.

## 1. Задача и target

- `pre_map`: `P(team_a выигрывает КАРТУ | что было публично или известно владельцу ДО драфта)`.
- `post_draft`: `P(team_a выигрывает КАРТУ | подтверждённые 10 героев, игроки и известный контекст ПОСЛЕ драфта, ДО начала карты)`.
- Label: проверенный исход `radiant_win` с учётом привязки Team A к Radiant/Dire; хранить отдельно от freeze признаков. Одна карта = одно наблюдение независимо от числа пользовательских сценариев/прогнозов.
- Никаких текущих K/D/A, GPM, gold, duration, outcome текущей карты в признаках. Даже данные после первых секунд игры запрещены для обоих режимов.
- До получения успешной temporal + series-aware проверки выдавать `unavailable`, а не числовой прогноз.

## 2. Матрица источников и степеней уверенности

| Источник | Для чего | Подтверждено | Ограничение |
|---|---|---|---|
| `GET /proMatches` OpenDota | Discovery pro карт, match_id, время, командные IDs, лига и исход при наличии | Endpoint задокументирован; `less_than_match_id` для последовательного backfill | Актуальную coverage проверять сетевым скриптом; не даёт полной пятёрки и драфта |
| `GET /matches/{match_id}` | 10 слотов, account IDs, 10 героев, стороны, победитель, picks/bans, series, patch, league | Поля описаны контрактом API | Драфт/аккаунты/расширенные replay stats могут быть `null`; `version` парсера не означает целостность |
| `GET /teams/{id}/matches` | Дополнительная история организации | Endpoint документирован | Название организации не является исторической пятёркой |
| `GET /teams/{id}/players`, `/proPlayers` | Кандидаты идентичностей, прошлые и текущие связи | Endpoint документирован | `is_current_team_member` не подтверждает lineup на дату будущей карты |
| `GET /leagues` | Турнир, возможный tier | Endpoint документирован | Tier/стадия/LAN могут быть неизвестны, источник и known_at отдельно |
| `GET /constants/patch`, dotaconstants и Valve patch notes | Периоды действия версии и справочники героев | Источники опубликованы | Release-time и значимость изменения героя требуют сверки; не выводить неизвестный patch без evidence |
| STRATZ GraphQL | Дополнение матчей/ролей/draft/реplays | GraphQL API публично описан | Конкретные поля, лимиты и условия доступа проверять только после получения ключа; fallback OFF |
| Zenodo v3, DOI `10.5281/zenodo.23166182` | Внешний корпус для исследования, IDs, drafts, labels при наличии | 90 530 pro-карт и 1 007 768 **внутриигровых снимков**; выпуск 2026-10-05 | НЕ готовый pre-match корпус: telemetry с 10-й минуты запрещена; проверить фактические колонки, лицензии и дубли; не смешивать мин-срезы как независимые карты |

Ссылки: https://opendota.apidocumentation.com/ ; https://stratz.com/ ; https://zenodo.org/records/23166182 ; https://github.com/odota/dotaconstants ; https://www.dota2.com/patches/ .

## 3. Минимальная запись raw карты (после завершения)

`match_id`, `start_time`, `radiant_team_id`, `dire_team_id`, `radiant_win`, `leagueid`, `series_id` (nullable), `patch` (nullable), `players[10]` с `account_id|null`, `player_slot`, `hero_id`; `picks_bans[]|null` с `is_pick`, `hero_id`, `team`, `order`; source, `fetched_at`, `raw_hash`, `pro_source_evidence`.

- Pro статус подтверждается `proMatches` или другим проверенным pro источником, не флагом на произвольной `/matches/{id}`.
- Для стороны обязательны уникальные слоты 0..4 и 128..132 (не массивный индекс).
- Для показателя сыгранности нужны **канонически определённые 10 игроков**; неизвестные учётные записи остаются `null`.
- Для модели драфта 10 различных `hero_id`; полные bans и точный `first_pick` для P0 не обязательны.
- `lane_role` не является достоверным Pos 1–5, нужны ручные роли или независимые подтверждения; `estimated_role`, `role_confidence`, `known_at` отдельно.
- `team_a_id` UI != Radiant ID. При неизвестных IDs организаций нужен статус `partial`.
- Патч определять по серверному API/верифицированному реестру; на границе обновления без достоверного знания — `unknown`.

## 4. Feature contract для pre_map, считать ТОЛЬКО на `cutoff_at`

Ниже — **кандидаты** признаков. Наличие API-поля не означает, что историческая предматчевая доступность доказана.

| Группа | Признак (пример имени) | Историческая зависимость | Missing policy |
|---|---|---|---|
| Rating | `elo_a_minus_b`, `elo_uncertainty_a/b` | завершённые ранее pro-карты + сила противника, рейтинги обновляются по хронологии | fallback prior + flag, не текущий глобальный рейтинг |
| Team form | `team_winrate_20_smoothed`, `team_matches_30d`, `opp_adjusted_form` | карты строго раньше cutoff, фильтр pro, strength-of-schedule | prior + n_raw/n_eff |
| Players | `player_strength_mean_diff`, `player_strength_min_diff`, `player_form_30d` | вся прошлая pro-карьера **по каноническому ID**, не только текущая организация | unknown + coverage |
| Roster | `exact_five_maps_90d`, `pair_coplay_mean_90d`, `pair_coplay_min_90d` | одна сторона, unordered 10 пар, прошлые организации учитываются | 0 сыгранных карт ≠ неизвестный ID |
| Churn | `roster_changes_last_10`, `standin_known`, `role_changes_last_10` | только история или опубликованный до cutoff lineup | unknown lineup → no normal full-confidence forecast |
| Role | `role_experience_last_30`, `role_assignment_confidence` | verified Pos1–5/estimated separate | nullable, missingness indicator |
| Patch | `target_patch_id` categorical, `maps_on_current_patch`, `patch_age_days` | официальная версия, известная к cutoff | patch_unknown flag |
| Context | `radiant_side_known`, `known_side_is_a_radiant`, `series_map_index` | только известное **до даты прогноза** | unknown, не подставлять фактическую сторону задним числом |
| Data quality | `identity_coverage`, `lineup_evidence`, `n_eff_form` | provenance и известность источника к cutoff | отдельный gate, не подменять likelihood |

Базовые сравнения: constant prior, Elo, Elo + roster, +player, +cohesion/role, +patch. Чтобы избежать leakage, ratings или rolling-агрегаты строить только из прошлого каждой карты и версионировать builder.

## 5. Feature contract для post_draft

Наследуем полный pre_map vector **из того же scenario/revision/cutoff**, а дополнительно:

| Признак | Источник и расчёт | Контроль |
|---|---|---|
| `hero_id_by_side_slot[10]` | 10 уникальных picks текущего драфта | известны только после завершения draft; bans не обязательны |
| `role_hero_assignment[10]` | игрок/герой/позиция (источник назначений известен) | inferred role → confidence |
| `player_hero_games_weighted`, `player_hero_wr_smoothed` | прежние pro-карты человека на этом герое | патч и время учитываются по policy, n_raw/n_eff |
| `hero_current_patch_prior`, `hero_pick_rate` | матчевые pro-карты на текущем и смежных патчах | нельзя использовать итоговую статистику текущего патча, подсчитанную после прогнозируемого матча |
| `ally_pair_advantages` | 10 unordered пар на сторону (20 для двух сторон) | один side+map считается один раз для каждой пары |
| `opponent_matchup_strength` | 25 directed межкомандных пар A→B в текущем драфте | считать на истории до cutoff, лаги и размеры выборок |
| `draft_order`, `first_pick` | точная последовательность picks/bans (P1) | только если подтверждена и известна на момент анализа |
| `pre_map_out_of_fold_logit` (для обучения) | честный OOF pre_model, не fit на той же карте | предотвращать stacking leakage |

Для 0–9 героев показывать **только описательную draft-аналитику**, без утверждаемой post_draft вероятности.

## 6. Feature availability и запреты leakage

**Три времени всегда раздельны:** `event_at`, `known_at`, `fetched_at`. `fetched_at` в 2026 не означает, что pre-map состав был известен в 2024.

Предложенные классы доступности:

- `verified_asof`: есть дата и доказательство, что информация была известна до cutoff;
- `user_asserted_asof`: введено самим владельцем до живого матча; для live сценария допустимо, но не имитировать историческое доказательство;
- `retrospective_fact`: извлечено из завершённой карты, допустимо для анализов условного *known-lineup*, но не для проспективной метрики pre-map;
- `unknown`: отсутствие данных; без фактической пятёрки модель должна применять явно валидированную degraded policy либо `unavailable`.

**Особенно критично:** тренировочную выборку pre-map нельзя формировать, подставляя фактические пятёрки, стороны и roster-новости, которые стали известны лишь после старта карты. Можно отдельно обучать и измерять условную модель «если пятёрка известна», строго маркируя её как conditional/retrospective.

Отдельные источники могут улучшить доказательство известности состава/расписания, но в P0 разрешён ручной ввод владельца и честная недоступность при неполноте исторического evidence.

## 7. Патчи, roster continuity и веса

- Одна универсальная экспонента для всех history features **запрещена**.
- `team_form`, `individual_pro_skill` — более длинный период при отдельной проверке transfer/drift;
- `player_hero`, `hero_pair`, `hero_matchup`, `hero_meta` — преимущественно текущий и ближайшие релевантные патчи;
- Hero rework/reset — явное событие в patch registry, нельзя переносить старые показатели без валидации;
- Для weighted статистики хранить `n_raw`, `n_eff=(sum(w))**2/sum(w²)`, весовые параметры и patch registry revision;
- На новом патче fallback через сглаживание к prior, quality gate или `unavailable`, а не выдуманный «95%».
- Все веса/half-life/tier различия выбирать на rolling temporal validation, тестировать ablative baseline.

## 8. Сбор обучающего корпуса: предложенный порядок

1. `GET /proMatches` небольшими курсорными порциями → уникальный набор IDs + metadata и checkpoint cursor; не ограничиваться топовыми организациями (selection bias).
2. `GET /matches/{id}` по каждому ID в rate budget → нормализовать labels и участников/драфты; сохранять completeness и source fingerprint.
3. Классифицировать: A = valid outcome+teams+10 player ids+10 heroes+patch, B = valid outcome+teams+10 heroes but missing identity/patch, C = partial. Не выбрасывать молча B/C из реестра импорта.
4. По времени вычислять ratings, canonical rosters, pairs, player-hero, meta и versioned aggregates; у каждого feature row — as-of provenance.
5. Строить `pre_map` условную и строгую as-of выборки отдельно; для `post_draft` не использовать текущие игровые telemetry.
6. Freeze датасет, сделать последовательные (rolling) train/calibration/validation/holdout partitions, series-aware. Никакого shuffle.
7. Сравнить Elo baseline, calibrated logistic и post_draft logistic; Brier/LogLoss/ECE + coverage/new-patch/stand-in strata. При отсутствии quality gate числовых вероятностей нет.

Объём корпуса заранее не гарантирован. Ориентир для планирования — широкий многотурнирный корпус в **десятках тысяч карт**, а не 50 карт одной команды. Сколько реально пригодно, покажет аудит; не писать фиктивный `n=...` в отчёт.

## 9. Пороговые проверки (предлагаемые DoD, не измеренные факты)

Скрипт `node scripts/audit-prediction-sources.mjs --sample 20 --out reports/opendota-coverage.json` измеряет наличие базовых полей **на выбранной выборке последних pro карт**. Это не репрезентативный долгосрочный benchmark.

- Успешно получены и корректно разобраны как минимум 20 подробных ответов; все match_id проверены на соответствие запрошенному.
- Каждое поле `identity_10`, `heroes_10`, `picks_10`, `patch`, `series`, `roles_hint`, `teams_2`, `league`, `label` имеет долю полноты и список match_id с отсутствием.
- Для тренировки `post_draft` требуются verify outcome, 10 уникальных heroes и known teams/sides; на уровне dataset должна быть доступна история к cutoff и достаточно примеров для независимой валидации.
- Для `pre_map` дополнительно проверять истинную pre-known availability текущих roster; API coverage `player_ids_10` **не доказывает** preknown.
- Нет массовых запросов при запуске audit: `--sample <= 50`, по умолчанию 20, последовательный backoff/rate throttle. Нет записи сырых payload в отчет.
- Матчи, для которых source/patch/roster статус неизвестен, не переобозначаются как валидные.

## 10. Следующие решения до S3

- Подтвердить actual coverage OpenDota на 20/50 картах разных периодов и выбрать диапазон backfill; для редких патчей сделать отдельно stratified audit.
- Проверить лицензии любых внешних CSV/дополнительных API; Zenodo v3 используется только после проверки колонок и точных условий лицензии.
- Для first pre_map model разделить `verified-asof` и `conditional-lineup` evaluation; строго прозрачно маркировать.
- Обновить `docs/DATA_QUALITY_GATES.md` после эмпирических измерений и не изменять пороги задним числом на основании holdout.

## 10. v9 — реальные аномалии raw picks и model-specific eligibility

В октябре 2026 владелец выполнил live sample 50 pro-карт (наблюдения в [PREDICTION_DATA_RESEARCH_STATUS.md](PREDICTION_DATA_RESEARCH_STATUS.md)). В некоторых записях финальные 10 героев не совпадают с `picks_bans`: 0, 11, 12 pick events, а ID команд/серии могут быть неизвестны. Поле `draft_actions` НЕ является доказательством полноценной последовательности. Нормативно: [DRAFT_DATA_INTEGRITY.md](DRAFT_DATA_INTEGRITY.md).

Post-draft `hero_id_by_side_slot[10]` и модель по **финальному драфту** не требуют полной последовательности банов, однако требуют доказательства, что все 10 героев были доступны в post-draft cutoff. Любая dataset eligibility определяется индивидуально для stage/feature policy и as-of; retrodictive карты с конечными героями без known-at — **отдельный conditional cohort**, не настоящий prospective quality result.

Аудитор v9 расширен: `draft_structurally_consistent` + причинные коды и `draft_order_valid=null` до исторического patch/mode validator. `schema_version=2` — обновить downstream consumers v8, не путать `null` (не проверено) и `false` (не прошло).
