# Первый прогноз 1win Essence III

12 ноября 2026 завершён S3-05/V1-retest/activation-owner-smoke/essence-main-event.

Через рабочий интерфейс сохранены назначение карты1, сценарий, owner-reviewed область основного этапа и прогноз Aurora—GamerLegion. Начало встречи по свежему PandaScore — 12 ноября16:00МСК. Прогноз выпущен03:02:09МСК: Aurora54,77%, GamerLegion45,23%. Это вероятность одной первой карты при выбранных пятёрках; результат серии не прогнозируется.

[Открыть сохранённый прогноз](http://localhost:5173/schedule-targets/a53fa5cc-be10-4d6d-83dd-91fa19d36ff1?forecast=17380251-5eba-49ac-8da3-4a78518c91b9&scenario=4c1203eb-4e20-4eaf-9545-ac5f0a49cf9a). [Журнал](http://localhost:5173/forecast-journal?report=c0fb8a2d-7fc4-4c93-a598-b0938aae326a).

Выбраны сохранённые владельцем Aurora: skiter/Mikoto/Ws`/Mira/kaori; GamerLegion: Yuma/RCY/Fayde/Bignum/Speeed.10/10 verified identities,143–233 eligible earlier pro maps на игрока; общий replay2158 карт, warmup2024-01-01. Issued snapshot неизменяем, версия модели и evidence hashes сохранены. Реальный исход и фактический состав пока неизвестны; журнал показывает «Ожидает проверки», verified N0/accuracy null. Выданный прогноз не является меткой для обучения.

Локальная лига7186 создана по ранее прочитанному OpenDota registry20486. Текущий ноябрьский license подтверждается55 картами и источниками;20177 пустой не выбран. Owner-reviewed scope ограничен основным этапом12–18ноября (until19ноябряUTC exclusive); ранний Play-in исключён. Источник Tier1 — esports.gg, обоснование/сопоставление записаны в scope и назначении. Это reviewed mapping для предстоящей игры, а не доказательство ещё не сыгранной карты; фактическую league/map связь проверяет отдельный outcome flow.

Проверки: реальный Chromium-flow, HTTP200/status done/reasons[], повторное открытие и reload, создание журнала, визуальная проверка результата, SHA сохранённого snapshot, issuedAt до scheduledAt, model_eligible.2232 карты и13 queue rows exact сохранены. Добавлены1лига/1scope/1сценарий/1назначение/1прогноз/1отчёт журнала; authentication/cache/source observations обновлялись штатно. Код, SQL-миграции, зависимости, артефакты модели и пороги не менялись; общая956-test регрессия не повторялась для операционной настройки. [Evidence](evidence/s3-05-essence-first-forecast.json).

Следующий предлагаемый срез — S1-16/tournament-onboarding: выбор/сопоставление нового турнира и сохранение reviewed main-event scope через понятный интерфейс владельца, с явным разбором одинаковых названий и reuse для матчей. Для обычной работы Codex не должен быть нужен. Модель: GPT-6.1 Sol · High. После игры отдельно связать прогноз с проверенной первой pro-картой и обновить журнал.
