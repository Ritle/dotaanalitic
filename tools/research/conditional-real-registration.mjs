/** Owner-reviewed source boundary. Hash/pointer checks are not a remote signature or a quality gate. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {registrationDigest} from './conditional-registration.mjs';
export const realPolicySha='77fa352544f4938e8b1cd69a2772894cff6b34df4b954e97677d36ea10ce388f';
export const realCandidateSha='9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b';
export const realExposureSha='ddffc46af97c411bba20e5d3c407a30584f8be076e8511f866df3eb73173c9e3';
export const realExposureIdsSha='556378e083780d2ef388996a17c09a04bde2f61481d07c6640a9e832e0417b04';
export const realSha=b=>createHash('sha256').update(b).digest('hex');
const Hash=z.string().regex(/^[a-f0-9]{64}$/),Time=z.string().datetime({precision:3}),Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const Text=z.string().min(1).max(16777216),Reason=z.string().trim().min(20).max(2000);
const Path=z.string().max(512).refine(v=>v&&!v.includes('\\')&&!v.includes(':')&&!v.startsWith('/')&&v.split('/').every(s=>s&&s!=='.'&&s!=='..')&&
 (/^(tools|packages|apps|ml)\//.test(v)||/^\.tools\/s304-[a-z-]+-runtime\//.test(v)||v==='pnpm-lock.yaml'));
const Pointer=z.string().regex(/^(\/[A-Za-z0-9_-]+)+$/).refine(v=>!v.split('/').some(s=>['__proto__','prototype','constructor'].includes(s)));
const Url=z.string().url().max(1024).refine(value=>{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&
 ['blast.tv','pro.eslgaming.com','api.opendota.com','api.stratz.com','stratz.com','api.pandascore.co'].includes(u.hostname)&&
 ![...u.searchParams.keys()].some(k=>/key|token|secret|password/i.test(k));});
const Source=z.object({url:Url,observedAt:Time,bodyText:Text,sha256:Hash}).strict();
const Binding=z.object({editionKey:z.string().max(256),leagueId:Id,stage:z.literal('main_event'),
 startBound:z.object({at:Time,basis:z.literal('owner_reviewed_lower_bound'),explanation:Reason}).strict(),calendar:Source,
 nativeReference:Source.extend({nativeIdPointer:Pointer,organizerUrlPointer:Pointer}).strict(),reviewNote:Reason}).strict();
export const RealRegistrationPackageSchema=z.object({format:z.literal('conditional-real-registration-package-v1'),
 policyText:Text,candidateText:Text,exposureText:Text,exposureBaseText:Text,exposureParentSha256:z.literal(realExposureSha),
 review:z.object({ownerUserId:z.string().uuid(),reviewedAt:Time,reason:Reason,bindings:z.array(Binding).length(2)}).strict(),
 executable:z.object({capturedAt:Time,code:z.record(Path,Hash).refine(v=>Object.keys(v).length<=500),environmentText:Text,environmentSha256:Hash}).strict(),
 collection:z.object({discovery:z.literal('registered_league_and_global_cursor_reconciliation'),enrollment:z.literal('reviewed-native-event-register-v1'),
  maxTargetMaps:z.number().int().positive(),maxHttpAttempts:z.number().int().positive(),maxDailyAttempts:z.number().int().positive(),
  maxConcurrentRequests:z.literal(1),assessmentMode:z.literal('one_terminal_assessment_after_window_and_grace')}).strict()}).strict();
export const requiredRealRegistrationCode=Object.freeze(['tools/research/conditional-real-registration.mjs','tools/research/conditional-real-registration-store.mjs',
 'packages/db/migrations/063_conditional_real_registration.sql','tools/research/conditional-registration.mjs','tools/research/conditional-registration-storage.mjs',
 'tools/research/conditional-enrollment.mjs','tools/research/conditional-evaluation.mjs','tools/research/conditional-future-source-binding.mjs',
 'tools/research/conditional-future-holdout.mts','tools/research/conditional_future_evaluate.py','tools/research/conditional-evaluator.mjs',
 'tools/research/player-hero-inference.mts','pnpm-lock.yaml',
 'tools/research/player-hero-fit.mjs','tools/research/player_hero_fit.py','tools/research/player-hero-experiment-plan.mjs',
 'tools/research/post-draft-dataset.mjs','tools/research/player_hero_evaluate.py','tools/research/post_draft_evaluate.py',
 'tools/research/post_draft_independent_evaluate.py','tools/research/post_draft_fit.py',
 'tools/research/conditional-evaluation-files.mjs','tools/research/conditional-future-source-files.mjs',
 'tools/research/player-hero-feature.mts','tools/research/conditional-enrollment-files.mjs',
 'packages/ingestion/dist/quality.js','packages/ingestion/dist/opendota/schemas.js','packages/db/dist/identity.js',
 'packages/contracts/dist/identity.js','packages/contracts/dist/v1-features.js','packages/contracts/dist/evaluation-discovery.js',
 'packages/prediction/dist/v1-features.js','.tools/s304-conditional-score-runtime/player-hero-inference.mjs',
 '.tools/s304-future-runtime/conditional-future-holdout.mjs','.tools/s304-future-runtime/player-hero-feature.mjs']);
const SeriesKey=z.string().refine(s=>{try{const a=JSON.parse(s);return Array.isArray(a)&&a.length===2&&a[0]==='opendota'&&Id.safeParse(a[1]).success&&JSON.stringify(a)===s;}catch{return false;}});
export const ExclusionIdsSchema=z.object({mapIds:z.array(Id).max(100000),canonicalSeriesKeys:z.array(SeriesKey).max(100000)}).strict();
function pointer(value,path){
 for(const key of path.slice(1).split('/')){assert(value!==null&&typeof value==='object'&&Object.hasOwn(value,key),'numeric_source_reference_missing');value=value[key];}
 return value;
}
export function validateRealRegistrationPackage(raw,recordedAt){
 Time.parse(recordedAt);const p=RealRegistrationPackageSchema.parse(raw);
 assert(Buffer.byteLength(JSON.stringify(p))<=32*1024*1024,'registration_package_limit');
 assert.equal(realSha(p.policyText),realPolicySha,'policy_hash');assert.equal(realSha(p.candidateText),realCandidateSha,'candidate_hash');
 assert.equal(realSha(p.exposureBaseText),realExposureIdsSha,'exposure_base_hash');
 const base=ExclusionIdsSchema.parse(JSON.parse(p.exposureBaseText)),exposure=ExclusionIdsSchema.parse(JSON.parse(p.exposureText));
 for(const key of ['mapIds','canonicalSeriesKeys']){
  const ids=new Set(exposure[key]);assert.equal(ids.size,exposure[key].length,'duplicate_exposure_id');
  assert(base[key].every(id=>ids.has(id)),'base_exposure_removed');
 }
 const policy=JSON.parse(p.policyText),proposal=policy.proposedRegistration;
 assert(recordedAt<proposal.decisionDeadline,'registration_deadline');assert(recordedAt<proposal.from,'registration_window_started');
 assert(p.review.reviewedAt<=recordedAt,'review_after_registration');assert(p.executable.capturedAt<=p.review.reviewedAt,'code_after_review');
 for(const path of requiredRealRegistrationCode)assert(p.executable.code[path],'required_code_missing');
 assert.equal(realSha(p.executable.environmentText),p.executable.environmentSha256,'environment_hash');JSON.parse(p.executable.environmentText);
 assert.equal(p.collection.maxTargetMaps,policy.budget.maxTargetMaps,'budget_changed');
 assert.equal(p.collection.maxHttpAttempts,policy.budget.maxHttpAttemptsIncludingRetries,'budget_changed');
 assert.equal(p.collection.maxDailyAttempts,policy.budget.maxHttpAttemptsPerUtcDay,'budget_changed');
 assert.equal(new Set(p.review.bindings.map(b=>b.leagueId)).size,2,'duplicate_native_id');
 assert.equal(new Set(p.review.bindings.map(b=>b.editionKey)).size,2,'duplicate_edition');
 const scope=proposal.events.map(event=>{
  const b=p.review.bindings.find(b=>b.editionKey===event.name);assert(b,'edition_missing');
  assert.equal(b.calendar.url,event.source,'calendar_reference_changed');
  assert(recordedAt<b.startBound.at,'start_bound_not_future');
  assert(b.startBound.at<=event.fromDate+'T00:00:00.000Z','start_bound_after_calendar_start');
  for(const source of [b.calendar,b.nativeReference]){
   assert.equal(realSha(source.bodyText),source.sha256,'source_bytes_changed');assert(source.observedAt<=p.review.reviewedAt,'observation_after_review');
  }
  const native=JSON.parse(b.nativeReference.bodyText),id=pointer(native,b.nativeReference.nativeIdPointer);
  assert(typeof id==='string'||typeof id==='number'&&Number.isSafeInteger(id),'numeric_source_reference_invalid');
  assert.equal(String(id),b.leagueId,'native_reference_id_mismatch');
  assert.equal(pointer(native,b.nativeReference.organizerUrlPointer),b.calendar.url,'organizer_reference_mismatch');
  return {editionKey:b.editionKey,leagueId:b.leagueId,stage:b.stage,earliestSeriesAt:b.startBound.at,
   startBoundBasis:b.startBound.basis,evidenceSha256:registrationDigest(b)};
 });
 return {format:'conditional-real-registration-plan-v1',ownerUserId:p.review.ownerUserId,policySha256:realPolicySha,
  candidateSha256:realCandidateSha,exposureSha256:realExposureSha,exposureSnapshotSha256:realSha(p.exposureText),
  window:{from:proposal.from,until:proposal.until,assessmentAt:proposal.assessmentAt,decisionDeadline:proposal.decisionDeadline},scope,
  reviewSha256:registrationDigest(p.review),executableSha256:registrationDigest(p.executable),collection:p.collection,
  trustBoundary:'owner_reviewed_retained_sources_not_remote_signature',
  realEvaluationAllowed:false,collectionAllowed:false,activationAllowed:false,deployable:false};
}
const threadEnvironment={OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1',PYTHONHASHSEED:'42'};
export async function inspectRealRegistrationEnvironment(){
 const executable=process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python';
 const r=spawnSync(executable,['tools/research/conditional_future_evaluate.py','environment'],{encoding:'utf8',env:{...process.env,...threadEnvironment},timeout:30000,maxBuffer:1024*1024});
 assert.equal(r.status,0,'environment_inspection_failed');
 return JSON.stringify({node:process.version,pythonEnvironment:JSON.parse(r.stdout),threads:threadEnvironment});
}
/** Called only by the internal registration service, never substituted with a caller ready flag. */
export async function verifyRealRegistrationRuntime(raw){
 const p=RealRegistrationPackageSchema.parse(raw),base=await realpath('.');
 const exposure=await readFile(JSON.parse(p.policyText).independence.exposure.path);
 assert.equal(realSha(exposure),realExposureSha,'runtime_exposure_parent_changed');
 const ledger=JSON.parse(exposure).result.ledger;
 assert.equal(JSON.stringify({mapIds:ledger.mapIds,canonicalSeriesKeys:ledger.canonicalSeriesKeys}),p.exposureBaseText,'runtime_exposure_projection_changed');
 for(const [path,expected] of Object.entries(p.executable.code)){
  const full=await realpath(resolve(path)),r=relative(base,full);assert(r&&!r.startsWith('..')&&!r.includes(':'),'code_outside_repository');
  assert.equal(realSha(await readFile(full)),expected,'runtime_code_changed:'+path);
 }
 const environment=await inspectRealRegistrationEnvironment();
 assert.equal(environment,p.executable.environmentText,'runtime_environment_changed');
 return {codeVerified:true,environmentSha256:realSha(environment)};
}
