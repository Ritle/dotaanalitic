# S1-07 — первичные источники и реальная доступность patch metadata

Capture выполнен **2026-10-31**, сохранён [JSON](../reports/s1-07-valve-source-capture.json) и [manifest SHA-256](../reports/s1-07-valve-source-manifest.json). Это live evidence, не synthetic fixture. Отчёт хранит источник/момент fetch/SHA-256 bytes/code hashes и числовую projection; полные тексты notes, account IDs и secrets не публикуются. Production registry/maps/models не изменялись.

## Что получено

Финальный capture: **7 HTTP200**, без повторов/ошибок: один [официальный patch list Valve](https://www.dota2.com/datafeed/patchnoteslist?language=english), по одному patch-notes feed и Steam announcement page для7.34c/7.34d/7.34e. Запрос Steam ограничен app570/official announcement feed, count100 и окном поиска до7 дней после nominal feed timestamp. Это ограниченный поиск публикаций, не доказательство полноты release history.

| Patch | `patch_timestamp` notes, UTC | Steam announcement `date`, UTC | Разница, секунды | Hero rows в notes |
|---|---|---|---:|---:|
| 7.34c | 2023-09-08 07:00:00 | 2023-09-09 01:51:09 | 67869 | 57 |
| 7.34d | 2023-10-04 07:00:00 | 2023-10-05 23:40:41 | 146441 | 53 |
| 7.34e | 2023-11-20 08:00:00 | 2023-11-21 01:58:14 | 64694 | 29 |

Числа проверяются по [7.34c notes](https://www.dota2.com/datafeed/patchnotes?language=english&version=7.34c), [7.34d notes](https://www.dota2.com/datafeed/patchnotes?language=english&version=7.34d), [7.34e notes](https://www.dota2.com/datafeed/patchnotes?language=english&version=7.34e). Первичные Steam API URL, news gid/title и timestamps сохранены в sourceEvidence/announcementCandidates отчёта. Например, [официальная Steam API page для7.34d](https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=570&count=100&maxlength=1&enddate=1697007600&feeds=steam_community_announcements) содержит gid5220292521182246432.

**Вывод ограничен:** источники расходятся как timestamps. Из этих полей нельзя установить точное время развёртывания патча. Не выбираем автоматически ни более ранний, ни более поздний timestamp. Дата публикации также не доказывает полноту patch coverage или историческую доступность полного нынешнего JSON. Поэтому verifiedReleasedAt/coverageUntil/knownAt=null и autoRegistryEligible=false **даже при совпавших timestamps**.

Hero rows подтверждают наличие записей в данном ответе, а не severity, unchanged для отсутствующих героев или Captains Mode eligibility. Аудитор не классифицирует текст notes, не вычисляет баланс или коэффициенты и не делает NLP-анализ. Отсутствующие blocks дают nullable counts; явно пустые arrays — наблюдённый0. Все impactLevel/availability остаются null до отдельного доказательства/review.

## Сопоставление с ранее полученными картами

Переиспользованы пять immutable S0-08 reports: recent20 и TI2021/2022/2023/2024 по5. Их file SHA зафиксированы; новых запросов OpenDota или импорта не было. **40 observations =40 unique map IDs**. Повторы снимков не увеличивали бы sample count.

Nominal интервалы официального feed дали кандидаты:7.29d→3 карты,7.30d→2,7.32c→5,7.34d→5,7.37c→5; recent20 остаются unknown, потому что конечный интервал последнего feed label открыт. Эти результаты **не являются verified patch IDs**. Provider coarse patch codes не подменяют canonical patch label/ID. Для всех40 verifiedPatchId и historicalKnownAt остаются null, verifiedPatchMaps=0; это не утверждение о фактической неверности версии, а отсутствие доказательства.

Real temporal evaluation: unavailable, scoredMaps=0, Brier/log loss/ECE=null. Наличие исходов/пиков в современных ответах не доказывает известность этих данных на старте исторической карты. Новые predictions/training samples не создавались; caller-supplied SHA не сертифицирует frozen cohort.

## Инструмент и воспроизведение

```powershell
pnpm install --frozen-lockfile
pnpm patch:sources --patch '7.34c,7.34d,7.34e' --out reports/new-valve-capture.json
```

В PowerShell строку patches обязательно заключать в кавычки: bare7.34d может интерпретироваться как numeric literal. Capture создаётся с flag wx и не перезаписывается; новый запуск — новый filename. Сеть только с backend CLI: fixed official endpoints, redirects запрещены, sequential pacing, max20 attempts на run, timeout15s, max body2MB, bounded retries429/5xx/network с Retry-After. Длинный cooldown блокирует следующую попытку; прекращение ожидания не даёт повторить запрос раньше. Query secrets/произвольный base URL не принимаются. Errors — code/status, без transport text. Client unit tests используют только явно synthetic ответы. Node tests проверяют immutable capture SHA и запрет auto eligibility; LF закреплён для byte hashes на Windows/CI.

Budget/cooldown здесь действуют в одном client/run; это ручной диагностический CLI, не scheduled collector и не замена durable shared OpenDota quota. Автоматический polling не включён.

Перед финальным capture были два ручных probe requests и отдельный7-request preliminary run; они не входят в manifest финальных7 attempts. Preliminary shell argument для7.34d был преобразован PowerShell в7.34; его ignored capture не публикуется и не считается финальным evidence. Цитированные числа относятся только к quoted final run, requestedPatches проверяется в manifest.

## Следующий шаг и открытый gate

**S1-07 остаётся unchecked.** Требуются доказательства фактических release boundaries/coverage и датированных hero availability/impact, затем достаточный проверенный real cohort с outcome availability/whole-series splits. Текущие primary fields для автоматического promotion непригодны. Не переносить Steam date в releasedAt или knownAt без соответствующего доказательства, не подменять raw patch filters nominal label, не назначать коэффициенты по final test. При появлении проверяемых архивных источников добавлять reviewed evidence отдельными записями; до этого вернуть unavailable. S1-08 не начинать. [Контракт foundation](S1_07_PATCH_TRANSFER.md).

Последующее решение владельца2026-10-31: после [архивного body checkpoint](S1_07_ARCHIVED_BODY.md) явно выбран **S1-08** по AGENTS§10. Запрет начинать его без такого выбора выше описывает прежнее состояние; теперь descriptive сравнение разрешено, S1-07 остаётся unchecked и обязательным P0 gate перед прогнозами. Раннее наличие одного текста подтверждено для5 карт, effective release/hero/outcome eligibility по-прежнему не доказаны.
