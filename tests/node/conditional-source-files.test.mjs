import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {sourceFixture} from '../fixtures/conditional-source-binding.mjs';
import {sourceSha} from '../../tools/research/conditional-future-source-binding.mjs';
const root=resolve(import.meta.dirname,'../..');
const run=(...args)=>spawnSync(process.execPath,['tools/research/conditional-future-source-files.mjs',...args],{cwd:root,encoding:'utf8',timeout:60000});
test('separate source-pinned files replay and refuse changed inputs, outputs, manifest or overwrite',async()=>{
 const dir=await mkdtemp(join(root,'.tools/source-files-test-'));
 try{
  const f=sourceFixture(),input=join(dir,'input.json'),archive=join(dir,'archive.json'),out=join(dir,'bound');
  const inputText=JSON.stringify(f.input),archiveText=JSON.stringify(f.archive);
  await writeFile(input,inputText);await writeFile(archive,archiveText);
  const args=['build',input,sourceSha(inputText),archive,sourceSha(archiveText),out];
  const created=run(...args);assert.equal(created.status,0,created.stderr);const receipt=JSON.parse(created.stdout);
  assert.equal(run('verify',out,receipt.manifestSha256).status,0);
  assert.notEqual(run(...args).status,0);
  assert.equal((await readFile(join(out,'features.json'),'utf8')).includes('teamAWon'),false);
  const original=await readFile(join(out,'labels.json'),'utf8'),labels=JSON.parse(original);labels.rows[0].teamAWon=!labels.rows[0].teamAWon;
  await writeFile(join(out,'labels.json'),JSON.stringify(labels));assert.notEqual(run('verify',out,receipt.manifestSha256).status,0);
  await writeFile(join(out,'labels.json'),original);
  await writeFile(archive,archiveText+' ');assert.notEqual(run('verify',out,receipt.manifestSha256).status,0);
  await writeFile(archive,archiveText);assert.notEqual(run('verify',out,'a'.repeat(64)).status,0);
  assert.notEqual(run('build',input,'a'.repeat(64),archive,sourceSha(archiveText),join(dir,'wrong')).status,0);
  assert.notEqual(run('build',input,sourceSha(inputText),archive,sourceSha(archiveText),'docs/source-output-test').status,0);
 }finally{
  const abs=resolve(dir);assert(abs.startsWith(join(root,'.tools')+'\\')||abs.startsWith(join(root,'.tools')+'/'));
  await rm(abs,{recursive:true,force:true});
 }
});
