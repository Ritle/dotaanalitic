import { it } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { runV1ReleaseCliScenario } from './v1-release-cli-scenario.js';
it('commits and recovers a source-bound release evaluation through the real CLI', async () => {
  const database = await testDatabase();
  try { await runV1ReleaseCliScenario(database.url); } finally { await database.close(); }
}, 180000);
it('verifies the frozen executable, journals a bound v2 evaluation and recovers it without activation', async () => {
  const database = await testDatabase();
  try { await runV1ReleaseCliScenario(database.url, true); } finally { await database.close(); }
}, 180000);
