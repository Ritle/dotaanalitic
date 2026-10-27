# ADR-lite: решения по проекту

| № | Решение | Обоснование |
|---|---|---|
| ADR-001 | Один владелец, локально | Никакого SaaS до подтверждения ценности продукта |
| ADR-002 | Только pro maps | Не смешивать паблики и профессиональные турниры |
| ADR-003 | Pre/post draft — разные модели | Доступный набор признаков отличается |
| ADR-004 | Point-in-time срезы | Исключение утечек будущего и честный backtest |
| ADR-005 | PostgreSQL — источник истины | Сторонние API не должны обслуживать каждый запрос UI |
| ADR-006 | Нет процентов без quality gate | Псевдовероятности опаснее честного «данных недостаточно» |
| ADR-007 | BIGINT IDs как strings в API | Избегаем IEEE754 precision loss |
| ADR-008 | Manual roster confirmation | API current flag не равен составу конкретной карты |
| ADR-009 | Monorepo TypeScript / pg jobs first | Лёгкий старт, без преждевременных сервисов |
| ADR-010 | Нет парсинга Dotabuff | Юридический и операционный риск неоправдан |


| ADR-011 | Roster != organization | Team тег не характеризует новый состав; team-wide/lineup/player metrics считать отдельно |
| ADR-012 | Cross-organization player pairs | Сыгранность пары/пятёрки сохраняется независимо от прошлых team_id |
| ADR-013 | No fixed stand-in penalty | Сила игрока и сыгранность могут меняться в противоположных направлениях; эффекты проверять только backtest |
| ADR-014 | Optional expected five | Неизвестный baseline не считается подтверждённым; сравнение замен при отсутствии baseline имеет статус unknown |

| ADR-015 | Separate priority from stage | `Sx-yy` = development order; `[P0/P1/P2]` = severity, prevents accidental scope creep |
| ADR-016 | Tri-temporal source data | event/known/fetched independent, historical backfills are not magically known earlier |
| ADR-017 | Series data first, series prediction later | map-focused MVP; BO2 may draw and series outcome is separate target |
| ADR-018 | Canonical verified player identities | similar nicknames/account rumors cannot automatically merge player stats |
| ADR-019 | Side and first-pick independent | Radiant/Dire, Team A/B and first pick are separate attributes |
| ADR-020 | Opponent-adjusted strength | evaluate Elo versus actual opponent at time of match, not today |
| ADR-021 | Shrink small samples | raw rate/N and prior-based smoothed estimate have distinct labels |
| ADR-022 | Evidence-backed hero availability | unknown historical restriction is not assumed allowed or banned |
| ADR-023 | Provenance and frozen predictions | audit source conflicts and link future outcomes without retroactively editing forecasts |
| ADR-024 | P1/P2 compatibility without early implementation | nullable fields and feature seams now; what-if, draft order, series forecast later |

## Технологические ADR v5

ADR-025..037 зафиксированы отдельно в [TECH_DECISION_REGISTER.md](TECH_DECISION_REGISTER.md). Они определяют паттерны, границы модулей, `pg-boss`/Kysely, пакетную модель обучения и проверку TS parity. Эта ссылка не меняет статус реализаций.
