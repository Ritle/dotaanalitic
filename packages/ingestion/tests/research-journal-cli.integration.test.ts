import { it } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { runEvidenceCliScenario } from './research-evidence-cli-scenario.js';
it('journals before output, retries exactly, requires a parent for revisions and recovers report/capture from PostgreSQL', async () => {
  const database = await testDatabase();
  try { await runEvidenceCliScenario(database.url); } finally { await database.close(); }
}, 120000);
