import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { managedImportFixture } from './managed-import-fixtures.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
it('replays all 51 source IDs and keeps a ready whole series split between two batches', async () => {
  const f = await managedImportFixture(true);
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import {readFile} from 'node:fs/promises';
      import {importSources,reconcileImportSources} from './scripts/lib/v1-import-diagnostics.mjs';
      const evidence=JSON.parse(await readFile(process.argv[1],'utf8')),dataset=JSON.parse(await readFile(process.argv[2],'utf8'));
      const source=await importSources(evidence),report=reconcileImportSources(source,dataset);
      console.log(JSON.stringify({coverage:report.coverage,ready:report.assessments.filter(r=>r.dataReady).map(r=>r.matchId)}));
    `, f.evidenceFile.path, f.datasetFile.path], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: ['201', '400'], coverage: { observedTargetMaps: 51, dataReadyMaps: 2, readyKnownSeries: 1 } });
  } finally { await f.cleanup(); }
}, 60000);
