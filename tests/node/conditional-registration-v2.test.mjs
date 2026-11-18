import test from 'node:test';
import assert from 'node:assert/strict';
import {registrationV2Fixture} from '../fixtures/conditional-registration-v2.mjs';
import {validateRegistrationV2} from '../../tools/research/conditional-real-registration-v2.mjs';
import {validateRealRegistrationPackage,realSha} from '../../tools/research/conditional-real-registration.mjs';
import {realRegistrationFixture} from '../fixtures/conditional-real-registration.mjs';
const at='2026-11-15T01:00:00.000Z';
test('v2 package validates source review and frozen model without granting collection',async()=>{
 const p=await registrationV2Fixture(),r=validateRegistrationV2(p,at);
 assert.equal(r.scope[0].leagueId,'90001');assert.equal(r.format,'conditional-real-registration-plan-v2');
 assert.equal(r.collectionAllowed,false);assert.equal(r.deployable,false);assert.equal(r.ownerUserId,p.review.reviewerUserId);
 assert.throws(()=>validateRealRegistrationPackage(p,at));assert.throws(()=>validateRegistrationV2(awaitlessV1(p),at));
});
function awaitlessV1(p){return {...p,format:'conditional-real-registration-package-v1'};}
test('old format still validates through its unchanged validator',async()=>{assert.equal(validateRealRegistrationPackage(await realRegistrationFixture(),at).format,'conditional-real-registration-plan-v1');});
test('rejects synthetic marker, missing owner, partial and diagnostic-only review',async()=>{
 for(const mutate of [p=>p.review.syntheticOnly=true,p=>p.review.reviewerUserId=null,p=>p.review.bindings[0].link=null,
  p=>p.review={format:'conditional-tournament-binding-report-v2',bindingsReady:true}]){
  const p=await registrationV2Fixture();mutate(p);assert.throws(()=>validateRegistrationV2(p,at));}
});
test('policy, model, budgets and code manifest cannot be substituted',async()=>{
 for(const mutate of [p=>p.policyText+=' ',p=>p.candidateText+=' ',p=>p.collection.maxHttpAttempts++,
  p=>delete p.executable.code['tools/research/conditional-tournament-binding-v2.mjs'],p=>p.executable.code['.env']='a'.repeat(64)]){
  const p=await registrationV2Fixture();mutate(p);assert.throws(()=>validateRegistrationV2(p,at));}
});
test('exposure and chronological constraints remain independent of source readiness',async()=>{
 const p=await registrationV2Fixture();assert.throws(()=>validateRegistrationV2(p,'2026-11-19T18:00:00.000Z'));
 p.executable.capturedAt='2026-11-15T00:31:00.000Z';assert.throws(()=>validateRegistrationV2(p,at),/code_after_review/);
 const q=await registrationV2Fixture(),ids=JSON.parse(q.exposureText);ids.mapIds.shift();q.exposureText=JSON.stringify(ids);
 assert.throws(()=>validateRegistrationV2(q,at),/base_exposure_removed/);
 const r=await registrationV2Fixture();r.executable.environmentText='{}';assert.throws(()=>validateRegistrationV2(r,at),/environment_hash/);
 r.executable.environmentSha256=realSha('{}');assert(validateRegistrationV2(r,at)); // Actual environment checked by storage runtime boundary.
});
