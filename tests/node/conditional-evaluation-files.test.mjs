import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {evaluationFixture} from '../fixtures/conditional-evaluation.mjs';
import {sourceSha} from '../../tools/research/conditional-future-source-binding.mjs';
const root=resolve(import.meta.dirname,'../..');
const run=(script,...args)=>spawnSync(process.execPath,['tools/research/'+script,...args],{cwd:root,encoding:'utf8',timeout:180000});
const cli=(...args)=>run('conditional-evaluation-files.mjs',...args);
test('immutable bundle replays both parents and rejects tampering, overwrite and archive substitution',async()=>{
 const dir=await mkdtemp(join(root,'.tools/evaluation-files-test-'));
 try{
  const f=evaluationFixture(),archive=join(dir,'archive.json');const archiveText=JSON.stringify(f.archive);await writeFile(archive,archiveText);
  const refs={};
  for(const [name,script,value] of [['source','conditional-future-source-files.mjs',f.featureInput],['enrollment','conditional-enrollment-files.mjs',f.enrollmentInput]]){
   const path=join(dir,name+'-input.json'),body=JSON.stringify(value),out=join(dir,name);await writeFile(path,body);
   const r=run(script,'build',path,sourceSha(body),archive,sourceSha(archiveText),out);assert.equal(r.status,0,r.stderr);
   refs[name]={directory:out,manifestSha256:JSON.parse(r.stdout).manifestSha256};
  }
  const spec=join(dir,'spec.json'),text=JSON.stringify({format:'conditional-evaluation-files-input-v1',...refs}),out=join(dir,'result');
  await writeFile(spec,text);const created=cli('build',spec,sourceSha(text),out);assert.equal(created.status,0,created.stderr);
  const receipt=JSON.parse(created.stdout);assert.equal(receipt.counts.pairedMaps,2);
  assert.equal(cli('verify',out,receipt.manifestSha256).status,0);
  assert.notEqual(cli('build',spec,sourceSha(text),out).status,0);
  const labelsPath=join(out,'labels.json'),original=await readFile(labelsPath,'utf8'),labels=JSON.parse(original);labels.rows[0].teamAWon=!labels.rows[0].teamAWon;
  await writeFile(labelsPath,JSON.stringify(labels));assert.notEqual(cli('verify',out,receipt.manifestSha256).status,0);
  await writeFile(labelsPath,original);
  const parentPath=join(refs.source.directory,'features.json'),parentText=await readFile(parentPath,'utf8');
  await writeFile(parentPath,parentText+' ');assert.notEqual(cli('verify',out,receipt.manifestSha256).status,0);await writeFile(parentPath,parentText);
  await writeFile(archive,archiveText+' ');assert.notEqual(cli('verify',out,receipt.manifestSha256).status,0);await writeFile(archive,archiveText);
  assert.notEqual(cli('verify',out,'a'.repeat(64)).status,0);
  assert.notEqual(cli('build',spec,sourceSha(text),'docs/evaluation-test').status,0);
 }finally{
  const rel=relative(join(root,'.tools'),resolve(dir));assert(rel&&!rel.startsWith('..')&&!rel.includes(':'));
  await rm(dir,{recursive:true,force:true});
 }
});
