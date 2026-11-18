import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {enrollmentFixture} from '../fixtures/conditional-enrollment.mjs';
import {sourceSha} from '../../tools/research/conditional-future-source-binding.mjs';
const root=resolve(import.meta.dirname,'../..');
const run=(...args)=>spawnSync(process.execPath,['tools/research/conditional-enrollment-files.mjs',...args],{cwd:root,encoding:'utf8',timeout:60000});
test('enrollment files replay; tampering, overwrite and outside-private paths fail closed',async()=>{
 const dir=await mkdtemp(join(root,'.tools/enrollment-files-test-'));
 try{
  const f=enrollmentFixture(),input=join(dir,'input.json'),archive=join(dir,'archive.json'),out=join(dir,'verified');
  const inputText=JSON.stringify(f.input),archiveText=JSON.stringify(f.archive);
  await writeFile(input,inputText);await writeFile(archive,archiveText);
  const args=['build',input,sourceSha(inputText),archive,sourceSha(archiveText),out];
  const created=run(...args);assert.equal(created.status,0,created.stderr);const receipt=JSON.parse(created.stdout);
  assert.equal(receipt.denominatorComplete,true);assert.equal(receipt.eligibleMaps,2);
  assert.equal(run('verify',out,receipt.manifestSha256).status,0);
  assert.notEqual(run(...args).status,0);
  const original=await readFile(join(out,'enrollment.json'),'utf8');assert(!original.includes('teamAWon'));assert(!original.includes('WinProbability'));
  const result=JSON.parse(original);result.eligibleMaps=999;
  await writeFile(join(out,'enrollment.json'),JSON.stringify(result));assert.notEqual(run('verify',out,receipt.manifestSha256).status,0);
  await writeFile(join(out,'enrollment.json'),original);
  await writeFile(archive,archiveText+' ');assert.notEqual(run('verify',out,receipt.manifestSha256).status,0);
  await writeFile(archive,archiveText);assert.notEqual(run('verify',out,'a'.repeat(64)).status,0);
  assert.notEqual(run('build',input,'a'.repeat(64),archive,sourceSha(archiveText),join(dir,'wrong')).status,0);
  assert.notEqual(run('build',input,sourceSha(inputText),archive,sourceSha(archiveText),'docs/enrollment-test').status,0);
 }finally{
  const rel=relative(join(root,'.tools'),resolve(dir));assert(rel&&!rel.startsWith('..')&&!rel.includes(':'));
  await rm(dir,{recursive:true,force:true});
 }
});
