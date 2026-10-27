# Observability/monitoring spec (P1)

## Structured JSON events

Logger для Fastify: Pino (`logger:true` in scaffold). Никаких token_hash, cookie, API_KEY, сырого user request payload, полных upstream headers в логах. ID корреляции в HTTP и ingest jobs.

Обязательные поля события: `event`, `request_id` или `job_id`, `source_provider`, `match_id`, `model_version`, `duration_ms`, `status`, `attempt` — только там, где применимо.

Метрики: 429/5xx per provider, ingestion lag, percent full 10-slot maps, drafts completeness, active patch coverage, job retries/dead letters, DB disk size, latest successful backup, model prediction count, prospective Brier by patch. Пороговые значения определять из реальной нагрузки, не выдумывать.

## Debug procedures

1. Upstream outage → halt fetch, retain last good data, provider freshness warning.
2. Too many retries → manual inspect dead letter, never silently duplicate map/map label.
3. Model drift → disable promotion, retain champion or `unavailable` if out-of-domain.
4. Full disk → stop ingestion before PostgreSQL writes fail, verify external backups, reduce retained raw payloads (not facts).

**v7 содержит спецификацию, не настроенный Prometheus/Grafana** (для одного VPS преждевременно).
