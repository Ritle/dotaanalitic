import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFixture } from './v1-runtime-fixtures.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
it('rejects malformed or tampered input before DB access without echoing private payloads',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'forecast-cli-'));
  try {
    const path=join(dir,'input.json'),bytes=JSON.stringify({...runtimeFixture().request,password:'synthetic-private-do-not-echo'});
    await writeFile(path,bytes); const sha=createHash('sha256').update(bytes).digest('hex');
    for(const hash of [sha,'0'.repeat(64)]) {
      const result=spawnSync(process.execPath,['scripts/v1-forecast.mjs','create',path,hash],{cwd:root,
        env:{...process.env,DATABASE_URL:''},encoding:'utf8',windowsHide:true,timeout:20000});
      expect(result.status).toBe(1); expect(result.stderr).toContain('V1_FORECAST_REJECTED'); expect(result.stderr).not.toContain('synthetic-private-do-not-echo');
    }
  } finally { const target=resolve(dir); if(!target.startsWith(resolve(tmpdir()))) throw Error('unsafe_test_cleanup'); await rm(target,{recursive:true,force:true}); }
},30000);
