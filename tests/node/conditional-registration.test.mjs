import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRegistration,bindAssessment,verifyAssessmentChain} from '../../tools/research/conditional-registration.mjs';
import {registrationFixture} from '../fixtures/conditional-registration.mjs';
const setup=()=>{const f=registrationFixture();return {...f,registration:prepareRegistration(f.plan,f.registeredAt)};};
test('freezes complete contract without granting live evaluation authority',()=>{
 const f=registrationFixture(),before=structuredClone(f),r=prepareRegistration(f.plan,f.registeredAt);
 assert.equal(r.plan.window.until,f.plan.window.until);assert.equal(r.realRegistration,false);assert.equal(r.realEvaluationAllowed,false);
 assert.equal(r.deployable,false);assert.deepEqual(f,before);assert(Object.isFrozen(r.plan));
});
for(const [name,change] of [
 ['late registration',f=>f.registeredAt=f.plan.window.from],
 ['already started series',f=>f.plan.scope[0].earliestSeriesAt=f.registeredAt],
 ['late evidence',f=>f.plan.scope[0].evidenceObservedAt='2030-01-01T00:00:00.000Z'],
 ['late executable',f=>f.plan.executable.capturedAt='2030-01-01T00:00:00.000Z'],
 ['window extension',f=>f.plan.window.until='2030-01-30T00:00:00.000Z'],
 ['short grace',f=>f.plan.window.assessmentAt='2030-02-04T00:00:00.000Z'],
 ['qualifier',f=>f.plan.scope[0].stage='qualifier'],
 ['candidate substitution',f=>f.plan.candidateSha256='b'.repeat(64)],
 ['missing code',f=>delete f.plan.executable.code['pnpm-lock.yaml']],
 ['path escape',f=>f.plan.executable.code['../outside']='a'.repeat(64)],
 ['duplicate edition',f=>f.plan.scope.push(f.plan.scope[0])],
 ['real self registration',f=>f.plan.syntheticOnly=false],
])test(name+' fails closed',()=>{const f=registrationFixture();change(f);assert.throws(()=>prepareRegistration(f.plan,f.registeredAt));});
test('retains first insufficient/negative result and appends only explicit linked correction',()=>{
 const f=setup(),first=bindAssessment(f.registration,f.execution,null,null,f.recordedAt);
 assert.equal(first.revision,1);assert.equal(first.execution.status,'insufficient');
 const changed=structuredClone(f.execution);changed.reportSha256='b'.repeat(64);changed.manifestSha256='c'.repeat(64);changed.status='negative';
 const second=bindAssessment(f.registration,changed,first,'Исправлен подтверждённый исход карты',f.recordedAt);
 assert.equal(second.revision,2);assert.equal(second.parentSha256,first.fingerprint);
 assert.equal(first.execution.status,'insufficient');assert.equal(verifyAssessmentChain(f.registration,[first,second]).length,2);
 assert.throws(()=>bindAssessment(f.registration,changed,first,null,f.recordedAt));
 assert.throws(()=>bindAssessment(f.registration,f.execution,first,'Нельзя повторить тот же результат',f.recordedAt));
});
for(const [name,change] of [
 ['scope',f=>f.execution.scope[0].leagueId='21'],
 ['candidate',f=>f.execution.candidateSha256='b'.repeat(64)],
 ['code',f=>f.execution.code['pnpm-lock.yaml']='b'.repeat(64)],
 ['environment',f=>f.execution.environmentSha256='b'.repeat(64)],
 ['exposure',f=>f.execution.exposureSha256='b'.repeat(64)],
 ['registered time',f=>f.execution.schedule.registeredAt='2029-12-30T00:00:00.000Z'],
 ['too early',f=>f.execution.schedule.assessedAt='2030-02-04T23:59:59.999Z'],
 ['future assessment',f=>f.execution.schedule.assessedAt='2030-02-06T00:00:00.000Z'],
 ['nonterminal result',f=>f.execution.status='not_due'],
 ['release flag',f=>f.execution.releaseGatePassed=true],
])test('report '+name+' cannot change frozen registration',()=>{
 const f=setup();change(f);assert.throws(()=>bindAssessment(f.registration,f.execution,null,null,f.recordedAt));
});
test('chain rejects reordered revisions, altered first result and forged parent hash',()=>{
 const f=setup(),first=bindAssessment(f.registration,f.execution,null,null,f.recordedAt);
 const changed={...f.execution,reportSha256:'b'.repeat(64),manifestSha256:'c'.repeat(64)};
 const second=bindAssessment(f.registration,changed,first,'Исправление исходного источника',f.recordedAt);
 assert.throws(()=>verifyAssessmentChain(f.registration,[second,first]));
 const tampered=structuredClone(first);tampered.execution.status='positive_synthetic_only';
 assert.throws(()=>verifyAssessmentChain(f.registration,[tampered]));
 const broken=structuredClone(second);broken.parentSha256='f'.repeat(64);
 assert.throws(()=>verifyAssessmentChain(f.registration,[first,broken]));
});
