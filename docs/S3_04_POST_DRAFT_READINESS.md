# S3-04/readiness — данные для модели после драфта

Проверка 13 ноября 2026. Завершён аудит данных, **модель post-draft не обучена и не активирована**. Действующий прогноз V1 до драфта остаётся отдельной моделью. [Сводное evidence](evidence/s3-04-readiness.json), [свежий OpenDota audit](evidence/s3-04-live-opendota.json).

## Что проверено

Весь локальный корпус: **2232 pro-карты**, 53 лиги, 23 июня 2021 — 4 ноября 2026. Это не равномерная историческая выборка. Сопоставлены текущая оценка качества, исходный immutable receipt и фактические десять slot/hero в канонической БД. SQL выполняется в repeatable-read READ ONLY транзакции, без импорта и обновления строк.

| Измерение | Карт из 2232 | Значение |
|---|---:|---|
| Десять различных финальных героев и допустимые слоты | 2232 | Наблюдённые герои сыгранной карты |
| Финальные герои совпадают с source receipt по каждому слоту | 2232 | В том числе стороны; порядок массива не используется |
| Десять установленных canonical player IDs | 2183 | 49 карт с неполной идентичностью |
| Две различные локальные команды | 2215 | 17 карт с неполной привязкой |
| Локальная привязка к серии | 2206 | 26 карт без серии; нельзя считать их автоматически BO1 |
| Raw пики структурно совпадают с финальными героями/сторонами | 2223 | У остальных9 нет событий драфта |
| Canonical patch interval | 0 | Provider patch label есть; это другая степень подтверждения |
| Typed context observations, включая heroes known-at | 0 | Историческая доступность пиков не доказана |

**2167 карт** проходят пересечение базовых inventory-проверок: pro, десять героев и canonical identities, совпадение с источником, source outcome status eligible, две команды, серия, отсутствие canonical conflict. Из них1888 относятся к2026;1152 имеют provider patch label60. Это **верхняя граница кандидатов для исследования**, а не готовый dataset: OutcomeVerifier, история до cutoff, policy, роль/патч, warmup и folds ещё должны оцениваться отдельно. Имена provider patches не превращены в подтверждённые release intervals.

В эти2167 входят9 карт без raw timeline. Их финальные герои согласуются с источником; отсутствие банов/полной последовательности само по себе не блокирует исследование hero-only. Raw events не изменялись, лишние пики не обрезаются. Для order/first-pick features понадобится отдельная проверка правил исторического режима/патча.

## Свежая контрольная выборка

Штатный `scripts/audit-prediction-sources.mjs --sample 20`:20 последних обнаруженных карт11–12ноября2026, все pro подтверждены league evidence. **22 HTTP200,0 retries/errors**, общий durable quota client.20/20 имеют десять уникальных героев и numeric accounts,18/20 — обе организации,17/20 — series ID,19/20 — согласованные raw picks. У карты9086956929 есть лишний pick/hero в raw events; финальная десятка остаётся полной.

Проверка не импортирует новые карты, не подтверждает canonical identities этих20карт и не заполняет known-at. `post_draft_heroes_known_at`, verified patch и patch-specific draft order в live-отчёте остаются **not assessed / null**, а не0% успешности или ложный PASS. Эта свежая выборка не является репрезентативной оценкой всего архива.

## Практическое решение

Не нужно разыскивать вручную исторические пики каждого матча, чтобы **начать исследование**. Допустим отдельный conditional cohort: финальные герои и участие игроков явно восстановлены по завершённой карте. Нельзя называть такую проверку настоящей исторической prospective оценкой или публиковать проценты как уже проверенный продукт.

Открытые вопросы для модели:

1. Зафиксировать отдельную policy reconstructed-final-draft, список кандидатов, признаки и предположения до обучения. Unknown роли/патчи не объявлять подтверждёнными; выбор hero-only baseline не означает реализацию всех role/patch features S3-04.
2. Проверить реальные исходы и историю до каждого cutoff; заморозить dataset/revisions. Одна карта — одна строка, вся серия в одном temporal fold.
3. Сравнить pre-match и post-draft на одинаковом независимом holdout; calibration/Brier/log loss, покрытие и критерии активации задаются заранее. Нельзя выбирать параметры по тесту или выдавать результат9пиков за полный драфт.
4. Для строгого выпуска отдельно закрыть доступность текущего драфта до старта и необходимые context/patch gates. Историческая retrospective пометка не исчезает после обучения.

## Воспроизведение

Из корня `dotaanalitic`, с уже собранными shared packages:

```powershell
node --env-file-if-exists=.env tools/audits/audit-post-draft-readiness.mjs .tools/new-post-draft-inventory.json
node --test tests/node/post-draft-readiness.test.mjs tests/node/draft-quality.test.mjs tests/node/coverage-audit.test.mjs
node --env-file-if-exists=.env scripts/audit-prediction-sources.mjs --sample 20 --out .tools/new-live-draft-audit.json
```

Последняя команда расходует квоту API; для повторного чтения уже полученного evidence её запускать не нужно. Локальный аудитор ограничен5000карт, никогда не перезаписывает существующий отчёт. В отчёте source IDs/SHA/fetchedAt, dataRevision, hash canonical lineup, map IDs и отдельные coverage denominators; нет прогнозов и raw private payload. Неизвестный результат проверки имеет `null` и не входит в assessed denominator; нулевая выборка имеет null ratio.

Аудитор находится в `tools/audits`: каталог `scripts` входит в frozen code inventory действующего V1. Первоначальное добавление туда корректно вызвало `ACTIVE_MODEL_EVIDENCE_INVALID`; после переноса исходный `model_eligible` восстановлен. Freeze, allowlist, модель и quality gate не менялись.

## Проверки и границы

18 целевых Node tests PASS (4 новых):0/лишние пики, неверная сторона, canonical mismatch/missing IDs/series/source, duplicate-map rejection, bigint, null ratio, lineup fingerprint. Null ratio сначала дал RED, затем исправлен. Два финальных read-only отчёта имеют одинаковый fingerprint. Frozen offline install, полный typecheck,962 unit/CLI tests и build PASS.54 historical migration checksums/docs links/diff PASS. Повторная запись existing report отклонена, SHA не изменён. Предупреждения Vite о bundle/Zod annotation нефатальные; отдельные полные PostgreSQL/browser suites не запускались. Финальная проверка после сборки: исходный модельный отчёт, forecast SHA и counts/queue совпали с baseline.

Рабочие2232карты,3прогноза,3сценария,13 exact queue rows и исходный forecast SHA сохранены; модель прежняя/model_eligible. Provider quota изменён штатными22HTTPзапросами. Новые проценты/обучение/activation/import/business writes не выполнялись. Сервис не перезапускался, general worker не включался.

**Следующая задача: S3-04/conditional-plan** — зафиксировать исследовательскую policy и границы временного сравнения pre-match против hero-only post-draft; после этого готовить frozen dataset. Рекомендуемая модель: GPT-6 Astra · High.
