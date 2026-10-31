import { Kysely, PostgresDialect, type Generated, type ColumnType } from 'kysely';
import pg from 'pg';
export { sql, CompiledQuery, type Kysely, type Transaction } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
export interface Database {
  heroes: { id: number; internal_name: string; localized_name: string; updated_at: Generated<Timestamp> };
  provider_quotas: { provider: string; next_request_at: Timestamp; blocked_until: Timestamp;
    minute_start: Timestamp; day_start: Timestamp; month_start: Timestamp;
    minute_used: number; day_used: number; month_used: number };
}

// SQL migrations remain the authority. SQL-first repositories use typed result
// rows via sql<T>, with the query builder for supported table projections.
export function createDatabase(connectionString: string) {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: new pg.Pool({
    connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000
  }) }) });
}
export type Db = ReturnType<typeof createDatabase>;
export type Executor = Db | import('kysely').Transaction<Database>;
export * from './temporal.js';
export * from './context-repository.js';
export * from './identity.js';
export * from './identity-repository.js';
export * from './game-context.js';
export * from './game-context-repository.js';
export * from './dataset-repository.js';
export * from './readiness.js';
export * from './readiness-repository.js';
