# S3-04 — продолжение получения истории

13 ноября 2026. **Получены все 88 оставшихся карт. Общий результат: детали 94 из 95 новых карт**, одна прежняя карта `8322631374` остаётся недоступной после двух HTTP 500. Незапрошенных ID больше нет. Два ранее известных проблемных receipt переиспользованы локально. В рабочую БД карты пока не импортировались.

## Запуски и бюджет

| Запуск | Новые успешные карты | HTTP attempts | Результат |
|---|---:|---:|---|
| Первый details, ранее выполнен | 6 | 8 | 6 HTTP200 + 2 HTTP500 для одного ID |
| Продолжение | 83 | 83 | 83 HTTP200; затем общий quota guard остановил следующий запрос до HTTP |
| После истечения минутного ограничения | 5 | 5 | 5 HTTP200, отдельный manifest и каталог |
| Всего | **94** | **96** | 94 HTTP200, 2 HTTP500, максимум 2 попытки/map |

Первый continuation manifest зарегистрирован до запросов. Квота отказала для `9045134920` с `retryAfterMs=59362` после ответа с minute remaining0. Это **не HTTP429**: этот запрос ещё не отправлялся. Partial с четырьмя `not_attempted` сохранён без изменений. Чтобы закончить разрешённый объём после cooldown, зарегистрирован отдельный quota-resume manifest: только эти пять ID, у всех HTTP attempts0, максимум9 новых попыток при прежних91. Использованы те же PostgreSQL quota budget и client; счетчики/cooldown не сбрасывались. После паузы потребовалось5запросов, общий предел100 сохранён. Старые успешные ответы и ID с двумя неудачами не запрашивались повторно.

Инструменты: `tools/research/post-draft-history-continuation.mjs`, `tools/research/post-draft-history-quota-resume.mjs`; 7+4 целевых теста. Они переиспользуют projection, detail assessment, partial collection и quota guard прежнего сборщика. Все существующие frozen tools/receipts/manifests остаются неизменными. `register` связывает родителей, исходные источники, код и бюджет; `run` создаёт immutable started marker; повторrun запрещён до DB/HTTP. Итоговый report сохраняет предыдущий quota отказ в `priorState`, не стирает его из истории.

## Что подтверждено и что ещё не готово

Все94новых детали и2локальных receipt согласуются с discovery по проверенным account/slot/time/league/outcome полям; завершение строго раньше соответствующего cutoff. Original payload SHA отделён от projection SHA, chat/profile не сохраняются, fetched-at реальный, known-at null. Synthetic sources отклоняются. Leagues и current identity evidence взяты из прежних замороженных источников; новых catalogue/profile/discovery запросов не было.

**33 карты** прошли проверку полей источника и покрытия идентичностей по frozen capture. Это первый фильтр, **не готовность к обучению**: ещё нужны актуальные локальные canonical references, проверка whole-series membership, source conflicts и план импорта. У них по-прежнему `trainingEligible:false`, `deployable:false`.

Для96наблюдений, включая2локальных, причины пересекаются:56карт имеют неизвестные identity links,16—source series unknown,13—team sides unknown. Всего80неподтверждённых account IDs в собранных данных. Они не превращены в canonical players по никам. Сохраняется [предыдущий локальный аудит](S3_04_LOCAL_READINESS.md), включая две неоднозначные группы серий пяти старых карт; совпадение соперников/дня не означает автоматическое объединение.

R1 dataset/fit/evaluation не менялись. Старый insufficient/negative результат и coverage175/223 не пересчитаны этим сбором. Данные являются дополнительной историей для будущей версии; публикации post-draft вероятностей нет.

## Среда и сохранность

До первого нового HTTP выявлен остановленный PostgreSQL: подключение отказало, `pg_ctl status` подтвердил отсутствие сервера. Запущен существующий `.tools/pgdata` по инструкции S0-00 скрытым background process, без init/reset/миграций. Состояние после запуска совпало с предыдущим checkpoint. API/Web/worker не запускались. Единственные рабочие записи сбора — `provider_quotas`.

Read-only preservation до/после:2232карты,3prediction_runs/снимка/сценария,13точных строк очереди, исходный forecast snapshot SHA и active model_eligible сохранены. Frozen dataset/fit/evaluation SHA неизменны. PostgreSQL оставлен запущенным.

## Проверки

11целевых Node-тестов PASS: exact remaining set, запрет refetch, aggregate/per-map caps, сохранение parent/partial и Retry-After, порядок записей, HTTP receipt binding, восстановление только quota отказа до HTTP, сохранение прежнего события в lineage. CLI offline replay, repeat refusal с недоступным DB URL, tamper refusal (копия report / подмена в памяти), сохранность всех трёх каталогов PASS. Независимо пересчитаны96attempts/94HTTP200/2HTTP500 и проверены discovery/cutoff/slot для всех88новых ответов. 54SQLchecksums PASS.

Frozen offline install/typecheck/962 общих теста/build — PASS. Финальный offline replay обоих новых запусков после build — PASS. Docs links и git diff --check — PASS. Отдельные browser/PG integration suites не запускались; production API/UI/SQL/dependencies не менялись.

```powershell
node tools/research/post-draft-history-continuation.mjs verify .tools/s304-history-continuation-r1
node tools/research/post-draft-history-quota-resume.mjs verify
```

Итоговый report SHA: `401b38e6b5abc01593e44c8e80f3fdc5d1a2316933f3aa5e59888cffb4c47608`.
[Evidence](evidence/s3-04-history-continuation.json) связывает все manifests/reports/проверки. Полные локальные данные: `.tools/s304-history-continuation-r1`, `.tools/s304-history-quota-resume-r1`.

## Следующая задача

**S3-04/history-import-plan:** [33 приоритетные карты](evidence/s3-04-history-import-plan-proposal.json) проверить по текущим локальным numeric identity links, team/league/series references и всем известным соседним картам серии. Подготовить неизменяемый план импорта либо точные причины исключения. Не объединять сомнительные серии, не обогащать автоматически80неизвестных игроков. Пока readonly: без новых HTTP, импорта, обучения, scoring и активации.

**Рекомендуемая модель: GPT-6 Astra · High.**
