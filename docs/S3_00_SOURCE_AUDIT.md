# S3-00 — повторный live-аудит источника

**2026-11-01 (Europe/Moscow).** Перед DatasetBuilder выполнен bounded live-запуск существующего аудитора: **10 уникальных recent-карт, 10 detailed responses, 12 HTTP attempts, все HTTP 200**. Ошибок и повторных attempts в этом capture нет. [Отчёт](evidence/s3-00-live-recent.json) и [manifest с SHA-256 отчёта, исходников и исполненного runtime](evidence/s3-00-source-manifest.json) фиксируют результат отдельно от прежнего [S0-08](S0_08_SOURCE_AUDIT.md).

Capture UTC: **2026-10-31T21:27:37.269Z → 21:27:51.782Z**. Выборка — первые 10 уникальных IDs из 100 строк `/proMatches`, без отбора по качеству. Даты карт: 2026-10-30T18:17:16Z — 2026-10-31T18:51:31Z; provider patch ID `60` у всех 10, лиги `16251` (1), `18631` (3), `20395` (6). Текущий каталог `/leagues` подтверждает pro tier всех 10, но не историческую доступность этого факта к началу карты.

| Наблюдаемый показатель | Покрытие |
|---|---:|
| Согласованный match ID, start, completed outcome, league | 10/10 |
| 10 native slots, 10 distinct source accounts, 10 distinct final heroes | 10/10 |
| Две организации / ненулевой series ID | 7/10 / 7/10 |
| 10 picks / structural consistency | 10/10 / 10/10 |
| Provider patch / integer lane_role hints | 10/10 / 10/10 |
| Canonical identities, verified patch, lineup known-at, heroes known-at, strict draft-order validity | Не оценены: denominator 0, ratio null |

Организации и series ID отсутствуют у `9070122200`, `9070048037`, `9069995494`; у этих трёх game_mode=22. Остальные семь имеют game_mode=2; lobby_type=1 у всех десяти. Причина отсутствия metadata не установлена. Structural consistency не доказывает историческую допустимость draft order; lane_role не подтверждает Pos 1–5. Финальная пятёрка и герои не доказывают их известность до начала карты.

Это небольшой свежий checkpoint, а не новая долгосрочная стратифицированная выборка. Прежние 40 карт S0-08 (20 recent + 20 исторических) сохранены без изменения. Три ID пересекаются с прежним capture: `9069021061`, `9068910292`, `9068883958`. Проценты двух запусков не объединяются; новые ответы не подменяют старые bytes. Ни один из этих аудитов сам по себе не подтверждает пригодность карты для строгого pre-match/post-draft датасета и не закрывает S1-07 empirical gate.

Воспроизведение после shared build и настройки DATABASE_URL:

```powershell
node --env-file-if-exists=.env scripts/audit-prediction-sources.mjs --sample 10 --out reports/s3-00-recent-new-capture.json
```

Повторный запуск создаёт новый capture с новыми source timestamps/hashes. Использованы существующие server-side timeout/retry/Retry-After, PostgreSQL quotas и предел 36 attempts; фактически понадобилось 12. Изменялись только счётчики квот провайдера: canonical maps, identities, registry proofs, datasets и models не импортировались. Отчёт не содержит raw payload, account IDs, профилей или ключей. Scope остаётся приватной персональной аналитикой через документированный API; условия и ограничения описаны в [DATA_SOURCES](DATA_SOURCES.md) и [S0-01](S0_01_PROVIDER_SPIKE.md).
