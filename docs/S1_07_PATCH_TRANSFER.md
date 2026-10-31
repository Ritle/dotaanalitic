# S1-07 — patch metadata и экспериментальные веса

## Evidence и границы

Миграция **014** добавляет immutable `patch_transition_evidence` и `hero_impact_evidence`; SQL001–013 сохраняются. В каждом proof раздельные event/known/fetched, источник, evidenceRef, reviewState и SHA-256; SQL запрещает UPDATE/DELETE и микросекундный обход. Идентичный повтор идемпотентен; новый proof атомарно увеличивает общий `game_context_registry_state.revision`. Старые mutable `patch_hero_impacts` не являются доказательствами. Поправки добавляются; несовместимые accepted/conflict proofs блокируют перенос, latest-write-wins отсутствует. Review/supersession UI остаётся S5-03.

Внутренний `PatchMetaRepository` принимает **уже проверенные** evidence; provider payload не становится accepted автоматически. Transition явно связывает predecessor и новый patch, содержит reviewed minor/moderate/major severity. Hero impact содержит unchanged/minor/moderate/major/rework: отсутствие записи **не означает unchanged**. `eventAt` используемого transition/impact должен совпадать с verified release timestamp. Это экспертная классификация, не измеренный эффект на победы.

`PatchHistoryRepository.readAsOf` получает caller-supplied `{matchId,startedAt}` и явную policy, читает registry в repeatable-read и вызывает чистый `resolveHistoryWeights`. Это назначение весов, **не SQL-отбор training features**: caller обязан отдельно доказать pro/outcome/lineup/role/identity/hero occurrence/known-as-of eligibility. Даже рассчитанные веса имеют deployable:false, predictionEligibility:not_assessed, probability=null.

## Перенос истории

- Карты строго startedAt<cutoffAt, IDs — decimal strings; дубликаты/неполный feature scope отвергаются, максимум5000 карт.
- Historical/target patch определяются `resolvePatchAt` по verified release/coverage с knowledgeAt=cutoff. Новая release/gap/conflict не дают fallback к старому label. На каждом переходе проверяются непрерывное покрытие и явный predecessor→patch; пропустить известный промежуточный релиз нельзя.
- Metadata учитывается при event/known<=cutoff. Поздний fetch допустим только при доказанном раннем knownAt; дата backfill не подтверждает историческую доступность.
- Для draft_hero нужны1–10 distinct hero IDs, известная league и подтверждённая target availability по общему `resolveHeroAt`; deny/unknown/conflict различаются. На каждом переходе нужны impact proofs каждого героя. Для strength hero IDs пусты, hero impact не применяется: отдельная policy, не hero WR для организации.
- `w_time=2^(-age_days/half_life_days)`, `w_patch=exp(-sum(transition_penalties))`, `w_hero=product(hero_factors)`, итог — произведение. Half-life/penalties/factors **передаёт caller**, production defaults отсутствуют. Policy version и полная конфигурация включаются в ключ. Нулевой factor при подтверждённом несовместимом rework допустим; коэффициенты fixture не являются production policy.
- Неполные metadata→weight=null с причиной; подтверждённый нулевой вес→0. Raw N, known weighted N, positive-weight N, missing N и scale-stable Kish N_eff отдельно. Kish не означает независимость карт. Raw patch distribution/targetPatchMaps/currentPatchShare/cold-start отдельно; cold-start означает ноль target-patch карт во входном cohort, не достаточность для модели. Эвристической уверенности нет.

Raw reports и chronological Elo автоматически не получают веса. Нет смешивания per-patch WR со weighted result или переписывания старых predictions. HTTP/UI не изменены: это внутренний repository + offline CLI с теми же границами, что foundation S0-06.

## Ключ и инвалидирование

SHA-256 включает полный запрос (карты/cutoff/feature/hero/league), все коэффициенты, resolver version и registry revision. Новый release correction/availability/transition/impact меняет revision и будущий ключ, даже если ранний as-of результат не изменился. Persistent cache не создаётся; будущий cache должен добавлять свои data/identity/feature revisions. Immutable snapshots не редактируются.

## Offline temporal ablation

`evaluatePatchWeightPolicies` принимает явный cohort одной заранее определённой сущности/метрики (не смесь героев/ролей/организаций), frozen dataset reference SHA, code revision, policyFrozenAt, provenance и train/calibration/validation/test. Одна строка — одна карта/verified pro outcome. Upstream обязан обеспечить hero/personal/roster eligibility; isPro:true само по себе не доказывает его. Caller claims не становятся проверенным датасетом. SQL verification и frozen DatasetBuilder остаются S3-00.

Проверяются уникальность map IDs, whole-series split, раздельные starts/label availability между стадиями и policyFrozenAt раньше validation. Для validation/test target строится rolling history строго раньше старта с labelKnownAt<target.startedAt; своя серия исключается целиком. Target label используется только для scoring. Evaluator не выбирает/не обучает policy, test не используется для настройки; конфигурация должна фиксироваться после train/calibration до validation/final test.

На одном покрытом cohort сравниваются unweighted / time-only / time+patch+hero historical rates. Нельзя исключать разные карты для улучшения метрик: при неполных metadata/нулевой effective history карта исключается из всех трёх вариантов с причиной. Brier/log loss/ECE (10 bins, numeric log clip1e-15), N/coverage и patch-cold-start slice отдельно; N0→null. SHA входа и registry snapshot дополняют caller-supplied dataset/code reference. Это descriptive-rate ablation, **не независимая проверка обученной модели** и не разрешение показывать прогноз.

## Запуск

```powershell
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm test:patch-history
pnpm patch:history readiness
pnpm patch:history weights .tools/explicit-weight-request.json
pnpm patch:history evaluate .tools/explicit-offline-cohort.json
```

CLI читает local registry/JSON и пишет JSON в stdout, не записывает evidence/maps/models. Форматы: PatchHistoryRequestSchema и PatchWeightEvaluationSchema в contracts, вход до5MB. Private input в Git не сохранять. Synthetic fixture допустима только для проверки механики; любой evaluator result остаётся deployable:false. Некорректный input/SQL error дают ненулевой exit без credentials.

## Оставшийся P0 gate

Механика проверяется synthetic math/patch/temporal fixtures и PostgreSQL. **Это не эмпирическая проверка качества на реальных картах.** Пока нет проверенных реальных patch/impact/availability metadata и достаточного исторически доступного pro cohort, реальный temporal backtest недоступен, коэффициенты не утверждены. S1-07 нельзя объявлять полностью закрытой по acceptance: она остаётся unchecked. Следующий шаг — источник и as-of coverage, затем воспроизводимый real chronological ablation и решение по policy; synthetic метрики не заменяют этот gate.
