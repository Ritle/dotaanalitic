# S1-20 — реальные данные и переход к выбранной встрече

После первого входа проверены текущие локальные API всех5 организаций и21 игрока: schema, raw wins+losses=N, nullable rate при N0, одна карта один раз, model=null. Это real local data из прежнего source import, не новая synthetic seed и не backtest.

| Организация | Локальных pro-карт |
|---|---:|
| GamerLegion | 4 |
| PARIVISION | 3 |
| Team Liquid | 3 |
| Team Spirit | 5 |
| Team Yandex | 5 |

У11 игроков есть история (десять по5 карт, Timado3), у10 игроков N0/rate=null. Проверены страницы организации и игроков с историей/пустой выборкой на1280/360px, отсутствуют pageerror/alerts/page overflow. Ни у одной организации не подтверждены patch metadata и обе полные canonical пятёрки на каждой карте: coverage warnings остаются, local participant links53/100. Это не основание публиковать прогноз.

## Расписание и заявки

Исходный cache от2026-11-01T00:35:51.137Z был stale. Штатные owner/CSRF UI controls выполнили два live source refresh: schedule2026-11-01T15:35:38.863Z и rosters2026-11-01T15:35:42.387Z. В schedule20 будущих встреч; проверена первая Team Synapse—SOLID, tournament22299, ожидаемые заявки5+5 из8 tournament teams. Участие конкретной пятёрки/роли не гарантируются. Source IDs не становятся canonical; поля выбора остались пустыми, сценарий не сохранён.

Полные source DTO, SHA/source clocks, local audit JSON и screenshots остаются только в ignored private-owner directory без публикации credentials. Это20 строк первой страницы, не гарантия полного мирового расписания. После TTL cache снова может стать stale; используйте явную кнопку обновления.

## Найденный UI разрыв

Карточка выбранной встречи расположена после всей таблицы. На360px при20 строках click первой встречи оставлял пользователя в таблице, а ожидаемые составы были далеко ниже viewport. Keyboard focus также оставался на кнопке строки.

`UpcomingView.vue` теперь после явного выбора и `nextTick` фокусирует region ожидаемых составов (`tabindex=-1`) и прокручивает его к началу экрана без анимации. Refresh источника не вызывает эту навигацию. Provider/canonical identity, ручные5+5/роли, scenario save, API/SQL/models не меняются.

Новый `upcoming-navigation.spec.ts` воспроизводит20 synthetic rows через реальный API/tempDB. До fix падает `toBeFocused`; после fix проверяются мышь, Enter следующей строки, выбранный заголовок, viewport top с допуском2 CSS pixels (браузер округляет subpixel position), пустые canonical inputs и disabled save. Синтетика остаётся только в disposable DB. Реальные приёмочные снимки не заменяют этот regression test.

Итоговые реально исполненные проверки — [PROGRESS](PROGRESS.md), актуальный запуск/owner — [PROJECT_STATE](PROJECT_STATE.md). Source/classification/model gates S1-07/S3-01 остаются открытыми, SQL001–020 immutable.

Следующий практический шаг — выбрать конкретную предстоящую встречу, для которой расширять проверенные локальные записи. Сейчас справочник содержит только5 организаций/21 игрока и не покрывает все20 upcoming rows. Новые player identities требуют numeric account evidence; совпадения имени недостаточно. Для такой верификации рекомендуется **GPT-6 Astra · High**; обычные UI-доработки — **GPT-6.1 Sol · Medium**. Не создавать неподтверждённые связи/составы автоматически.
