import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {evaluatorFixture} from '../fixtures/conditional-evaluator.mjs';
import {sourceSha} from '../../tools/research/conditional-future-source-binding.mjs';
const root=resolve(import.meta.dirname,'../..');
const run=(script,...args)=>spawnSync(process.execPath,['tools/research/'+script,...args],{cwd:root,encoding:'utf8',timeout:240000});
const cli=(...args)=>run('conditional-evaluator.mjs',...args);
test('source-to-score synthetic replay, current Python/TS parity, tampering and real refusal',async()=>{
 const dir=await mkdtemp(join(root,'.tools/conditional-evaluator-test-'));
 try{
  const f=evaluatorFixture(),archive=join(dir,'archive.json'),archiveText=JSON.stringify(f.archive);await writeFile(archive,archiveText);
  const refs={};
  for(const [name,script,input] of [['source','conditional-future-source-files.mjs',f.featureInput],['enrollment','conditional-enrollment-files.mjs',f.enrollmentInput]]){
   const file=join(dir,name+'-input.json'),body=JSON.stringify(input),out=join(dir,name);await writeFile(file,body);
   const result=run(script,'build',file,sourceSha(body),archive,sourceSha(archiveText),out);assert.equal(result.status,0,result.stderr);
   refs[name]={directory:out,manifestSha256:JSON.parse(result.stdout).manifestSha256};
  }
  const bundleSpec=join(dir,'bundle-spec.json'),bundleText=JSON.stringify({format:'conditional-evaluation-files-input-v1',...refs}),bundle=join(dir,'bundle');
  await writeFile(bundleSpec,bundleText);const built=run('conditional-evaluation-files.mjs','build',bundleSpec,sourceSha(bundleText),bundle);assert.equal(built.status,0,built.stderr);
  const spec=join(dir,'spec.json'),text=JSON.stringify({format:'conditional-evaluator-files-input-v1',bundle:{directory:bundle,manifestSha256:JSON.parse(built.stdout).manifestSha256},schedule:f.schedule}),out=join(dir,'result');
  await writeFile(spec,text);const result=cli('build',spec,sourceSha(text),out);assert.equal(result.status,0,result.stderr);
  const receipt=JSON.parse(result.stdout);assert.equal(receipt.result,'insufficient');assert.equal(receipt.counts.pairedMaps,2);assert(receipt.parity.bundleRows.maxAbsoluteError<1e-12);
  assert.equal(cli('verify',out,receipt.manifestSha256).status,0);
  assert.notEqual(cli('build',spec,sourceSha(text),out).status,0);
  const reportPath=join(out,'report.json'),original=await readFile(reportPath,'utf8'),report=JSON.parse(original);report.metrics.H2_cal.brier=0;
  await writeFile(reportPath,JSON.stringify(report));assert.notEqual(cli('verify',out,receipt.manifestSha256).status,0);await writeFile(reportPath,original);
  assert.notEqual(cli('verify',out,'a'.repeat(64)).status,0);
  assert.notEqual(cli('build',spec,sourceSha(text),'docs/evaluator-test').status,0);
  const realSpec=join(dir,'real.json'),realText=JSON.stringify({format:'conditional-evaluator-files-input-v1',
   bundle:{directory:'.tools/s304-evaluation-local-bundle-r1',manifestSha256:'fa37909f8d00ddbeea3d580fd99e5b0061886f1709a5c38786660cc7928b25fa'},schedule:null});
  await writeFile(realSpec,realText);const real=cli('build',realSpec,sourceSha(realText),join(dir,'real-result'));assert.equal(real.status,0,real.stderr);
  assert.equal(JSON.parse(real.stdout).result,'unregistered');assert.equal(JSON.parse(real.stdout).scoringPerformed,false);
 }finally{
  const rel=relative(join(root,'.tools'),resolve(dir));assert(rel&&!rel.startsWith('..')&&!rel.includes(':'));
  await rm(dir,{recursive:true,force:true});
 }
});
