import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {realRegistrationFixture} from '../fixtures/conditional-real-registration.mjs';
import {validateRealRegistrationPackage as validate} from '../../tools/research/conditional-real-registration.mjs';
const now='2026-11-15T01:00:00.000Z',sha=s=>createHash('sha256').update(s).digest('hex');
test('binds exact policy/candidate/exposure, numeric references and review without authorizing scoring',async()=>{
 const p=await realRegistrationFixture(),r=validate(p,now);
 assert.equal(r.scope.length,2);assert.equal(r.scope[0].leagueId,'90001');assert.equal(r.window.from,'2026-11-20T00:00:00.000Z');
 assert.equal(r.trustBoundary,'owner_reviewed_retained_sources_not_remote_signature');assert.equal(r.realEvaluationAllowed,false);assert.equal(r.deployable,false);
});
test('a boolean, a preflight diagnostic or a name-only provider record cannot authorize registration',async()=>{
 const p=await realRegistrationFixture();assert.throws(()=>validate({...p,registrationReady:true},now));
 assert.throws(()=>validate({format:'conditional-registration-preflight-v1',registrationReady:true},now));
 p.review.bindings[0].nativeReference.bodyText=JSON.stringify({event:{nativeLeagueId:'90001',name:'BLAST SLAM IX'}});
 p.review.bindings[0].nativeReference.sha256=sha(p.review.bindings[0].nativeReference.bodyText);
 assert.throws(()=>validate(p,now),/reference/);
});
test('refuses wrong native ID, qualifier stage, duplicate IDs and wrong organizer reference',async()=>{
 for(const mutate of [p=>p.review.bindings[0].leagueId='20359',p=>p.review.bindings[0].stage='qualifier',
  p=>p.review.bindings[1].leagueId=p.review.bindings[0].leagueId,
  p=>p.review.bindings[0].calendar.url='https://blast.tv/other']){
  const p=await realRegistrationFixture();mutate(p);assert.throws(()=>validate(p,now));
 }
});
test('rejects altered evidence/policy/artifact/exposure and future observation or review',async()=>{
 for(const mutate of [p=>p.policyText+=' ',p=>p.candidateText+=' ',p=>p.exposureBaseText+=' ',
  p=>p.review.bindings[0].calendar.bodyText+='tamper',p=>p.review.bindings[0].nativeReference.bodyText+='tamper',
  p=>p.review.bindings[0].nativeReference.observedAt='2026-11-15T00:31:00.000Z',
  p=>p.review.reviewedAt='2026-11-16T00:00:00.000Z']){
  const p=await realRegistrationFixture();mutate(p);assert.throws(()=>validate(p,now));
 }
});
test('exposure refresh may append but cannot remove, duplicate or corrupt prior exclusions',async()=>{
 const p=await realRegistrationFixture(),ids=JSON.parse(p.exposureText);ids.mapIds.push('9999999999999');p.exposureText=JSON.stringify(ids);
 assert(validate(p,now)); // SQL additionally requires each addition to be in the locked local inventory.
 ids.mapIds.shift();p.exposureText=JSON.stringify(ids);assert.throws(()=>validate(p,now),/base_exposure_removed/);
 const d=await realRegistrationFixture(),duplicate=JSON.parse(d.exposureText);duplicate.mapIds.push(duplicate.mapIds[0]);d.exposureText=JSON.stringify(duplicate);
 assert.throws(()=>validate(d,now),/duplicate_exposure_id/);
 const hidden=await realRegistrationFixture();hidden.executable.code['.env']='a'.repeat(64);assert.throws(()=>validate(hidden,now));
});
test('refuses deadline equality, a started scope and budget increase; never shifts the fixed window',async()=>{
 const p=await realRegistrationFixture();assert.throws(()=>validate(p,'2026-11-19T18:00:00.000Z'),/deadline/);
 p.review.bindings[0].startBound.at=now;assert.throws(()=>validate(p,now),/start_bound/);
 const b=await realRegistrationFixture();b.collection.maxHttpAttempts++;assert.throws(()=>validate(b,now),/budget/);
});
test('requires adapter/SQL/core code and exact environment bytes; rejects credential URLs and prototype pointers',async()=>{
 const p=await realRegistrationFixture();delete p.executable.code['packages/db/migrations/063_conditional_real_registration.sql'];assert.throws(()=>validate(p,now),/required_code/);
 const env=await realRegistrationFixture();env.executable.environmentText+=' ';assert.throws(()=>validate(env,now),/environment_hash/);
 const url=await realRegistrationFixture();url.review.bindings[0].nativeReference.url='https://api.stratz.com/?token=secret';assert.throws(()=>validate(url,now));
 const ptr=await realRegistrationFixture();ptr.review.bindings[0].nativeReference.nativeIdPointer='/__proto__/id';assert.throws(()=>validate(ptr,now));
});
