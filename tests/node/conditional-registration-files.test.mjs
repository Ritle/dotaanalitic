import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createSyntheticRegistration,readSyntheticJournal,appendSyntheticAssessment} from '../../tools/research/conditional-registration-files.mjs';
import {registrationFixture} from '../fixtures/conditional-registration.mjs';
const root=resolve(import.meta.dirname,'../..'),sha=b=>createHash('sha256').update(b).digest('hex');
test('exclusive journal serializes competing first writes and detects rollback, tampering and gaps',async()=>{
 const dir=await mkdtemp(join(root,'.tools/registration-test-'));
 try{
  const f=registrationFixture(),path=join(dir,'journal'),saved=await createSyntheticRegistration(path,f.plan,f.registeredAt),ref={directory:dir,manifestSha256:f.execution.manifestSha256};
  await assert.rejects(createSyntheticRegistration(path,f.plan,f.registeredAt));
  const append=()=>appendSyntheticAssessment(path,saved.registrationSha256,'-',f.execution,ref,null,f.recordedAt);
  const races=await Promise.allSettled([append(),append()]);assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
  const first=races.find(r=>r.status==='fulfilled').value;
  const journal=await readSyntheticJournal(path,saved.registrationSha256,first.headSha256);assert.equal(journal.commits.length,1);
  await assert.rejects(readSyntheticJournal(path,saved.registrationSha256,'-'));
  const changed={...f.execution,manifestSha256:'b'.repeat(64),reportSha256:'c'.repeat(64),status:'negative'};
  await assert.rejects(appendSyntheticAssessment(path,saved.registrationSha256,first.headSha256,changed,{...ref,manifestSha256:changed.manifestSha256},null,f.recordedAt));
  const second=await appendSyntheticAssessment(path,saved.registrationSha256,first.headSha256,changed,{...ref,manifestSha256:changed.manifestSha256},'Исправлен результат исходной карты',f.recordedAt);
  assert.equal(second.revision,2);assert.equal((await readSyntheticJournal(path,saved.registrationSha256,second.headSha256)).commits[0].commit.execution.status,'insufficient');
  const file=join(path,'000001.json'),original=await readFile(file,'utf8');await writeFile(file,original+' ');
  // First row whitespace is not semantic corruption; its commit hash still validates.
  assert.equal((await readSyntheticJournal(path,saved.registrationSha256,second.headSha256)).commits.length,2);
  const altered=JSON.parse(original);altered.commit.execution.status='positive_synthetic_only';await writeFile(file,JSON.stringify(altered));
  await assert.rejects(readSyntheticJournal(path,saved.registrationSha256,second.headSha256));await writeFile(file,original);
  await writeFile(join(path,'000004.json'),'{}');await assert.rejects(readSyntheticJournal(path,saved.registrationSha256,second.headSha256));
 }finally{const rel=relative(join(root,'.tools'),dir);assert(rel&&!rel.startsWith('..'));await rm(dir,{recursive:true,force:true});}
});
test('unfinished or locked write fails closed and cannot be treated as a committed result',async()=>{
 const dir=await mkdtemp(join(root,'.tools/registration-partial-'));
 try{
  const f=registrationFixture(),path=join(dir,'journal'),saved=await createSyntheticRegistration(path,f.plan,f.registeredAt);
  await mkdir(join(path,'.append-lock'));
  await assert.rejects(readSyntheticJournal(path,saved.registrationSha256,'-'));
  await assert.rejects(appendSyntheticAssessment(path,saved.registrationSha256,'-',f.execution,{directory:dir,manifestSha256:f.execution.manifestSha256},null,f.recordedAt));
  await writeFile(join(path,'000001.json'),'{');await assert.rejects(readSyntheticJournal(path,saved.registrationSha256,sha('{')));
 }finally{const rel=relative(join(root,'.tools'),dir);assert(rel&&!rel.startsWith('..'));await rm(dir,{recursive:true,force:true});}
});
