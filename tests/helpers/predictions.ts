import { sql, type Db } from '../../packages/db/src/index.js';
import { runtimeFixture } from '../../packages/db/tests/v1-runtime-fixtures.js';
/** Only disposable test databases; no real model or roster claim. */
export async function seedPredictionScenario(db: Db) {
  await sql`INSERT INTO teams(id,name) VALUES (11,'Synthetic A'),(22,'Synthetic B')`.execute(db);
  await sql`INSERT INTO leagues(id,opendota_league_id,name) VALUES (77,77,'Synthetic tournament')`.execute(db);
  for (let i = 101; i <= 110; i++) await sql`INSERT INTO players(id,nickname) VALUES (${String(i)},'Synthetic player')`.execute(db);
  return runtimeFixture().input;
}
