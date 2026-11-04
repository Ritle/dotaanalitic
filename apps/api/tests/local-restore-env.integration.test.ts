import {test,expect,vi} from 'vitest';
import {fileURLToPath} from 'node:url';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {runLocalRestoreDrill} from '../../../scripts/lib/local-restore-drill.mjs';
test('explicit local connection is not overridden by an inherited libpq hostaddr',async()=>{
  const source=await testDatabase();
  try{
    // This invalid numeric address must never reach libpq; no remote host is contacted.
    vi.stubEnv('PGHOSTADDR','not-a-numeric-address');
    const r=await runLocalRestoreDrill({databaseUrl:source.url,pgBin:process.env.PG_BIN||fileURLToPath(new URL('../../../.tools/pgsql/bin/',import.meta.url))});
    expect(r.report.targetDropped).toBe(true);
  }finally{vi.unstubAllEnvs();await source.close();}
},90000);
