/** Versioned registration boundary. Never coerce v2 evidence into fabricated v1 source fields. */
import assert from 'node:assert/strict';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {RealRegistrationPackageSchema,ExclusionIdsSchema,requiredRealRegistrationCode,realPolicySha,realCandidateSha,
 realExposureSha,realExposureIdsSha,realSha,inspectRealRegistrationEnvironment} from './conditional-real-registration.mjs';
import {TournamentBindingReviewV2Schema,inspectTournamentBindingsV2} from './conditional-tournament-binding-v2.mjs';
import {collectionRuntimeManifestPaths} from './conditional-collection-runtime.mjs';
const Time=z.string().datetime({precision:3});
export const registrationV2Paths=Object.freeze(['tools/research/conditional-real-registration-v2.mjs',
 'tools/research/conditional-real-registration-v2-store.mjs','tools/research/conditional-tournament-binding-v2.mjs',
 'packages/db/migrations/066_conditional_registration_v2.sql']);
export const RegistrationV2PackageSchema=RealRegistrationPackageSchema.extend({format:z.literal('conditional-real-registration-package-v2'),
 review:TournamentBindingReviewV2Schema,collection:RealRegistrationPackageSchema.shape.collection.extend({enrollment:z.literal('reviewed-native-event-register-v2')})});
export async function registrationV2ManifestPaths(){return [...new Set([...await collectionRuntimeManifestPaths(),...registrationV2Paths])].sort();}
export function validateRegistrationV2(raw,recordedAt){
 Time.parse(recordedAt);const p=RegistrationV2PackageSchema.parse(raw);
 assert(Buffer.byteLength(JSON.stringify(p))<=33554432,'registration_package_limit');
 assert.equal(realSha(p.policyText),realPolicySha,'policy_hash');assert.equal(realSha(p.candidateText),realCandidateSha,'candidate_hash');
 assert.equal(realSha(p.exposureBaseText),realExposureIdsSha,'exposure_base_hash');
 const base=ExclusionIdsSchema.parse(JSON.parse(p.exposureBaseText)),exposure=ExclusionIdsSchema.parse(JSON.parse(p.exposureText));
 for(const key of ['mapIds','canonicalSeriesKeys']){const ids=new Set(exposure[key]);assert.equal(ids.size,exposure[key].length,'duplicate_exposure_id');
  assert(base[key].every(id=>ids.has(id)),'base_exposure_removed');}
 const policy=JSON.parse(p.policyText),proposal=policy.proposedRegistration;
 assert(recordedAt<proposal.decisionDeadline,'registration_deadline');assert(recordedAt<proposal.from,'registration_window_started');
 assert.equal(p.review.syntheticOnly,false,'synthetic_review_forbidden');assert(p.review.reviewerUserId,'owner_review_required');
 assert(p.executable.capturedAt<=p.review.reviewedAt,'code_after_review');
 for(const path of [...requiredRealRegistrationCode,...registrationV2Paths])assert(p.executable.code[path],'required_code_missing');
 assert.equal(realSha(p.executable.environmentText),p.executable.environmentSha256,'environment_hash');JSON.parse(p.executable.environmentText);
 assert.equal(p.collection.maxTargetMaps,policy.budget.maxTargetMaps,'budget_changed');
 assert.equal(p.collection.maxHttpAttempts,policy.budget.maxHttpAttemptsIncludingRetries,'budget_changed');
 assert.equal(p.collection.maxDailyAttempts,policy.budget.maxHttpAttemptsPerUtcDay,'budget_changed');
 const review=inspectTournamentBindingsV2(p.review,p.policyText,recordedAt);assert(review.bindingsReady,'binding_review_unavailable');
 return {format:'conditional-real-registration-plan-v2',ownerUserId:p.review.reviewerUserId,policySha256:realPolicySha,
  candidateSha256:realCandidateSha,exposureSha256:realExposureSha,exposureSnapshotSha256:realSha(p.exposureText),
  window:{from:proposal.from,until:proposal.until,assessmentAt:proposal.assessmentAt,decisionDeadline:proposal.decisionDeadline},
  scope:review.bindings.map(b=>({editionKey:b.editionKey,leagueId:b.leagueId,stage:b.stage,earliestSeriesAt:b.startBound.at,
   startBoundBasis:b.startBound.basis,evidenceSha256:b.evidenceSha256})),reviewSha256:review.reviewSha256,
  executableSha256:realSha(JSON.stringify(p.executable)),collection:p.collection,trustBoundary:review.trustBoundary,
  collectionAllowed:false,realEvaluationAllowed:false,activationAllowed:false,deployable:false};
}
export async function verifyRegistrationV2Runtime(raw){
 const p=RegistrationV2PackageSchema.parse(raw),base=await realpath('.');
 for(const path of await registrationV2ManifestPaths())assert(p.executable.code[path],'runtime_manifest_incomplete');
 const exposure=await readFile(JSON.parse(p.policyText).independence.exposure.path);assert.equal(realSha(exposure),realExposureSha,'runtime_exposure_parent_changed');
 const ledger=JSON.parse(exposure).result.ledger;
 assert.equal(JSON.stringify({mapIds:ledger.mapIds,canonicalSeriesKeys:ledger.canonicalSeriesKeys}),p.exposureBaseText,'runtime_exposure_projection_changed');
 for(const [path,expected] of Object.entries(p.executable.code)){const full=await realpath(resolve(path)),r=relative(base,full);
  assert(r&&!r.startsWith('..')&&!r.includes(':'),'code_outside_repository');assert.equal(realSha(await readFile(full)),expected,'runtime_code_changed:'+path);}
 const environment=await inspectRealRegistrationEnvironment();assert.equal(environment,p.executable.environmentText,'runtime_environment_changed');
 return {codeVerified:true,environmentSha256:realSha(environment)};
}
