# UI Design System — Personal Analytics

## Principles

Тёмная спокойная панель для чтения больших статистических таблиц, а не эффектный рекламный лендинг. Нельзя окрашивать win probability как подтверждённый результат, скрывать sample size или имитировать actual данных.

## Токены

CSS design tokens определены в `apps/web/src/design-tokens.css`. Повторно используемые компоненты разрабатывать вокруг токенов, а не значений hex в каждой карточке.

- `bg/surface/elevated`, `border`, `text/muted`, `accent`, `success`, `warning`, `danger`.
- Шаг сетки 4/8/12/16/24/32/48px, карточки radius 10–16px, доступная клавиатурная навигация, hover не заменяет focus.
- Предпочтение таблицам с чёткими заголовками, фильтрами патча, времени, турнира и роли. Не показывать статистику за период без указания sample size.

## Стандартные UI состояния для асинхронных данных

`loading | ready | stale | unavailable | unauthorized | error | insufficient_data`. `unavailable` не заменять вымышленными `50%`. Для прогноза показывать stage + lineup confirmation + patch + model version + cutoff timestamp + данные для confidence.

## Шаблоны компонентов (после S1 / S2)

- `StatValue`: value + units + sample size + coverage + observed as-of.
- `LineupEditor`: пять player IDs/side, verified/expected marker, roles and stand-in badges.
- `PatchSelector`: текущий патч / предыдущий с явным decay/cold-start.
- `ForecastCard`: model stage, p(win), calibrated status, comparison baseline, reasons, confidence/coverage.
- `DraftBoard`: 10 unique hero IDs, picks/ban order, side, role assignment, scenario revision conflicts.
- `ErrorPanel`: retry cause, source freshness, no sensitive error dumps.

## Accessibility

Контраст >= WCAG AA, видимый focus, reduce-motion, графики с текстовым эквивалентом, p(win) не только цветом; responsive на 360px. Для complex tables горизонтальный скролл, без обрезания колонок.

**Состояние v7:** реализованы только CSS tokens и базовая оболочка; компоненты не считаются выполненными.
