import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {bundleFixture} from '../fixtures/conditional-future-holdout.mjs';
import {conditionalDigest} from '../../.tools/s304-future-runtime/conditional-future-holdout.mjs';
const root=resolve(import.meta.dirname,'../..');
const run=(...args)=>spawnSync(process.execPath,['tools/research/conditional-future-holdout.mjs',...args],{cwd:root,encoding:'utf8',timeout:60000});
test('exclusive artifact and full replay reject overwritten, rehashed or foreign-policy results',async()=>{
 const directory=await mkdtemp(join(root,'.tools/future-file-test-'));
 try{
  const source=join(directory,'input.json'),output=join(directory,'result.json');
  await writeFile(source,JSON.stringify(bundleFixture()));
  const first=run('build',source,output);assert.equal(first.status,0,first.stderr);
  assert.equal(run('verify',output).status,0);assert.notEqual(run('build',source,output).status,0);
  const saved=JSON.parse(await readFile(output,'utf8'));
  for(const mutate of [p=>{p.result.rows[0].inputs.eloLogit=12;},p=>{p.policySha256='b'.repeat(64);},p=>{p.deployable=true;}]){
   const corrupt=structuredClone(saved);mutate(corrupt);const {fingerprint,...body}=corrupt;corrupt.fingerprint=conditionalDigest(body);
   await writeFile(output,JSON.stringify(corrupt));assert.notEqual(run('verify',output).status,0);
  }
  assert.notEqual(run('build',source,'docs/forbidden-future.json').status,0);
 }finally{
  const absolute=resolve(directory);assert(absolute.startsWith(join(root,'.tools')+'\\')||absolute.startsWith(join(root,'.tools')+'/'));
  await rm(absolute,{recursive:true,force:true});
 }
});
