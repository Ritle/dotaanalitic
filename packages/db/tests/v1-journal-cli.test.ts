import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
it('rejects forged filters or labels before DB access without exposing input',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'journal-cli-'));
  try {
    const path=join(dir,'request.json'),text=JSON.stringify({requestId:randomUUID(),filters:{winner:'private-fixture-value'}});
    await writeFile(path,text);
    const r=spawnSync(process.execPath,['scripts/v1-journal.mjs','create',path,createHash('sha256').update(text).digest('hex')],
      {cwd:fileURLToPath(new URL('../../../',import.meta.url)),env:{...process.env,DATABASE_URL:''},encoding:'utf8',windowsHide:true,timeout:20000});
    expect(r.status).toBe(1);expect(r.stderr).toContain('V1_JOURNAL_REJECTED');expect(r.stderr).not.toContain('private-fixture-value');
  }finally{const target=resolve(dir);if(!target.startsWith(resolve(tmpdir())))throw Error('unsafe_test_cleanup');await rm(target,{recursive:true,force:true});}
},30000);
