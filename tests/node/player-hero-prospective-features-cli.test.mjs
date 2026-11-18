import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {featureFixture} from '../fixtures/player-hero-prospective-features.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const cli=(...args)=>spawnSync(process.execPath,['tools/research/player-hero-prospective-features.mjs',...args],
  {cwd:root,encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,DATABASE_URL:'postgres://invalid:1/no_network'}});
test('offline CLI persists/replays immutable features and rejects hash, input and promotion tampering',()=>{
  const dir=mkdtempSync(join(root,'.tools/prospective-feature-cli-')),input=join(dir,'input.json'),output=join(dir,'output.json');
  try {
    writeFileSync(input,JSON.stringify(featureFixture()));
    const prepared=cli('prepare',input,output);assert.equal(prepared.status,0,prepared.stderr);
    const bytes=readFileSync(output),hash=sha(bytes);
    assert.equal(cli('verify',input,output,hash).status,0);
    assert.notEqual(cli('prepare',input,output).status,0);assert.deepEqual(readFileSync(output),bytes);
    assert.notEqual(cli('verify',input,output,'0'.repeat(64)).status,0);
    const modified=JSON.parse(bytes);modified.result.deployable=true;writeFileSync(output,JSON.stringify(modified));
    assert.notEqual(cli('verify',input,output,sha(readFileSync(output))).status,0);
    writeFileSync(output,bytes);writeFileSync(input,readFileSync(input,'utf8')+' ');
    assert.notEqual(cli('verify',input,output,hash).status,0);
    writeFileSync(input,'{"secret":"private-sentinel-should-not-print"}');
    const rejected=cli('prepare',input,output);assert.notEqual(rejected.status,0);
    assert(!rejected.stderr.includes('private-sentinel'));assert(!rejected.stdout.includes('private-sentinel'));
  } finally {for(const p of [input,output])try{unlinkSync(p);}catch{}rmdirSync(dir);}
});
