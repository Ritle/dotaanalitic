import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {verifyRetestRegistryCode} from '../../scripts/lib/v1-retest-registry-verifier.mjs';
const cli=args=>spawnSync(process.execPath,['scripts/retest-model.mjs',...args],{encoding:'utf8',windowsHide:true,
  env:{...process.env,DATABASE_URL:'postgres://synthetic-private:synthetic-password@invalid.invalid/never-connect'}});
test('activation CLI rejects caller-controlled code and invalid contracts without exposing input or database credentials',async()=>{
  const root=await mkdtemp(join(tmpdir(),'retest-transition-'));
  try {const path=join(root,'request.json');await writeFile(path,JSON.stringify({requestId:'bad',runtime:'synthetic-private-input'}));
    const r=cli(['transition',path]);assert.equal(r.status,1);assert.equal(JSON.parse(r.stderr).status,'unavailable');
    assert(!r.stderr.includes('synthetic-private'));assert(!r.stderr.includes('synthetic-password'));assert.equal(r.stdout,'');
  } finally {await rm(root,{recursive:true,force:true});}
});
test('activation CLI bounds local requests and requires an explicit command',async()=>{
  const root=await mkdtemp(join(tmpdir(),'retest-transition-size-'));
  try {const path=join(root,'large.json');await writeFile(path,'x'.repeat(65537));
    assert.equal(cli(['transition',path]).status,1);assert.equal(cli([]).status,2);assert.equal(cli(['activate']).status,2);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('reviewed dispatch compatibility accepts exact compiled bytes and rejects even an appended instruction',async()=>{
  const manifest=JSON.parse(await readFile('scripts/lib/v1-retest-runtime-compatibility.json','utf8'));
  assert.deepEqual(manifest.changes.map(c=>c.path).sort(),['packages/db/dist/schedule-page-runtime.js','packages/db/dist/v1-runtime-repository.js']);
  const root=await mkdtemp(join(tmpdir(),'retest-reviewed-code-'));
  try {for(const c of manifest.changes){
    const path=join(root,c.path);await mkdir(dirname(path),{recursive:true});const bytes=await readFile(c.path);await writeFile(path,bytes);
    await verifyRetestRegistryCode([{path:c.path,sha256:c.before}],pathToFileURL(root+sep));
    await writeFile(path,Buffer.concat([bytes,Buffer.from('\nthrow Error("altered");\n')]));
    await assert.rejects(verifyRetestRegistryCode([{path:c.path,sha256:c.before}],pathToFileURL(root+sep)),/code_changed/);
  }} finally {await rm(root,{recursive:true,force:true});}
});
