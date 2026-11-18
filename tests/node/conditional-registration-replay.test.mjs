import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadSyntheticExecution} from '../../tools/research/conditional-registration-files.mjs';
import {registrationFixture} from '../fixtures/conditional-registration.mjs';
import {sourceSha} from '../../tools/research/conditional-future-source-binding.mjs';
const root=resolve(import.meta.dirname,'../..');
const run=(...args)=>spawnSync(process.execPath,['tools/research/conditional-registration-files.mjs',...args],{cwd:root,encoding:'utf8',timeout:240000});
test('replayed evaluator binds full executable graph to synthetic contract; real result and overwrite refused',async()=>{
 const dir=await mkdtemp(join(root,'.tools/registration-replay-'));
 try{
  const executionDir='.tools/s304-conditional-evaluator-synthetic-r1',executionSha='2338cd98c9cdd892567e55f2a3bad04dcebdb79deb1704544a1a2e91622c6492';
  const execution=await loadSyntheticExecution(executionDir,executionSha),f=registrationFixture();
  const {registeredAt,from,until,assessmentAt,assessedAt}=execution.schedule;
  f.plan.window={from,until,assessmentAt};f.plan.scope=execution.scope.map(s=>({...s,stage:'main_event',earliestSeriesAt:from,evidenceSha256:execution.inputSha256,evidenceObservedAt:registeredAt}));
  f.plan.executable={capturedAt:registeredAt,code:execution.code,environmentSha256:execution.environmentSha256};
  f.plan.sourceReadinessSha256=execution.manifestSha256;
  const planPath=join(dir,'plan.json'),planText=JSON.stringify(f.plan),journal=join(dir,'journal');await writeFile(planPath,planText);
  const created=run('create-synthetic',planPath,sourceSha(planText),journal,registeredAt);assert.equal(created.status,0,created.stderr);
  const saved=JSON.parse(created.stdout);
  const append=run('append-synthetic',journal,saved.registrationSha256,'-',executionDir,executionSha,assessedAt);assert.equal(append.status,0,append.stderr);
  const receipt=JSON.parse(append.stdout);assert.equal(receipt.revision,1);
  const verified=run('verify-synthetic',journal,saved.registrationSha256,receipt.headSha256);assert.equal(verified.status,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).firstStatus,'insufficient');
  assert.notEqual(run('create-synthetic',planPath,sourceSha(planText),journal,registeredAt).status,0);
  assert.notEqual(run('verify-synthetic',journal,saved.registrationSha256,'a'.repeat(64)).status,0);
  const before=await readFile(join(journal,'000001.json'),'utf8');
  await assert.rejects(loadSyntheticExecution('.tools/s304-conditional-evaluator-real-r1','a29f930b2259503ae09bbaec5e1fd929620e8f5ee7d9179ace2b50130415ec19'),/real_execution/);
  assert.equal(await readFile(join(journal,'000001.json'),'utf8'),before);
 }finally{const rel=relative(join(root,'.tools'),dir);assert(rel&&!rel.startsWith('..'));await rm(dir,{recursive:true,force:true});}
});
