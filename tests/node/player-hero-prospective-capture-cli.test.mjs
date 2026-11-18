import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,unlink,rmdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {fixture} from '../fixtures/player-hero-prospective-input.mjs';
import {captureDigest} from '../../.tools/s304-prospective-capture-runtime/player-hero-prospective-capture.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const run=(...args)=>spawnSync(process.execPath,['tools/research/player-hero-prospective-capture.mjs',...args],
  {cwd:root,encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,DATABASE_URL:'invalid-offline-sentinel'}});

test('offline persistence verifies external SHA, refuses overwrite, altered input and rehashed promotion',async()=>{
  const dir=await mkdtemp(join(root,'.tools/prospective-contract-test-')),input=join(dir,'input.json'),output=join(dir,'capture.json');
  try{
    const inputBytes=JSON.stringify(fixture());await writeFile(input,inputBytes);
    const created=run('capture',input,output);assert.equal(created.status,0,created.stderr);
    const original=await readFile(output),expected=sha(original),saved=JSON.parse(original);
    assert.equal(saved.syntheticOnly,true);assert.equal(saved.primaryEligible,false);
    assert.equal(run('verify',input,output,expected).status,0);
    assert.equal(run('capture',input,output).status,1);assert.deepEqual(await readFile(output),original);
    assert.equal(run('verify',input,output,'b'.repeat(64)).status,1);
    await writeFile(input,inputBytes+' ');assert.equal(run('verify',input,output,expected).status,1);
    await writeFile(input,inputBytes);
    const forged=structuredClone(saved);forged.primaryEligible=true;const {fingerprint,...body}=forged;
    forged.fingerprint=captureDigest(body);const changed=JSON.stringify(forged);await writeFile(output,changed);
    assert.equal(run('verify',input,output,sha(changed)).status,1);
    await writeFile(output,original);assert.equal(run('verify',input,output,expected).status,0);
  }finally{for(const path of [input,output])await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});await rmdir(dir);}
});

test('malformed private input produces safe Russian errors and no output artifact',async()=>{
  const dir=await mkdtemp(join(root,'.tools/prospective-private-test-')),input=join(dir,'input.json'),output=join(dir,'capture.json');
  try{
    await writeFile(input,JSON.stringify({credential:'private-sentinel-never-echo'}));
    const r=run('capture',input,output);assert.equal(r.status,1);assert.match(r.stderr,/Снимок отклонён/);
    assert(!r.stderr.includes('private-sentinel')&&!r.stdout.includes('private-sentinel'));
    await assert.rejects(()=>readFile(output),{code:'ENOENT'});
  }finally{await unlink(input);await rmdir(dir);}
});
