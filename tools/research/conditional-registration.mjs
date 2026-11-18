/** Pure contract harness. Local assertions do not attest real registration or source readiness. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
const Hash=z.string().regex(/^[a-f0-9]{64}$/),Time=z.string().datetime({precision:3});
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const Path=z.string().min(1).max(512).refine(v=>!v.includes('\\')&&!v.includes(':')&&!v.startsWith('/')&&v.split('/').every(s=>s&&s!=='.'&&s!=='..'));
const Code=z.record(Path,Hash).refine(v=>Object.keys(v).length<=500);
export const requiredRegistrationCode=Object.freeze(['tools/research/conditional_future_evaluate.py','tools/research/conditional-evaluator.mjs',
 'tools/research/conditional-evaluation.mjs','tools/research/conditional-enrollment.mjs','tools/research/conditional-future-source-binding.mjs',
 'tools/research/conditional-future-holdout.mts','tools/research/player-hero-inference.mts','pnpm-lock.yaml']);
export const RegistrationPlanSchema=z.object({format:z.literal('conditional-registration-plan-v1'),syntheticOnly:z.literal(true),
 window:z.object({from:Time,until:Time,assessmentAt:Time}).strict(),
 scope:z.array(z.object({editionKey:z.string().min(1).max(256),leagueId:Id,stage:z.literal('main_event'),earliestSeriesAt:Time,
  evidenceSha256:Hash,evidenceObservedAt:Time}).strict()).min(1).max(10),
 policySha256:z.literal('77fa352544f4938e8b1cd69a2772894cff6b34df4b954e97677d36ea10ce388f'),
 candidateSha256:z.literal('9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b'),
 exposure:z.object({sha256:z.literal('ddffc46af97c411bba20e5d3c407a30584f8be076e8511f866df3eb73173c9e3'),maps:z.literal(5674),series:z.literal(1768)}).strict(),
 executable:z.object({capturedAt:Time,code:Code,environmentSha256:Hash}).strict(),sourceReadinessSha256:Hash}).strict();
const Schedule=z.object({registeredAt:Time,from:Time,until:Time,assessmentAt:Time,assessedAt:Time}).strict();
export const AssessmentBindingSchema=z.object({format:z.literal('conditional-assessment-binding-v1'),syntheticOnly:z.literal(true),
 manifestSha256:Hash,inputSha256:Hash,reportSha256:Hash,policySha256:Hash,candidateSha256:Hash,exposureSha256:Hash,
 code:Code,environmentSha256:Hash,scope:z.array(z.object({leagueId:Id,editionKey:z.string().min(1).max(256)}).strict()).min(1).max(10),
 window:z.object({fromAt:Time,until:Time}).strict(),schedule:Schedule,
 status:z.enum(['insufficient','negative','positive_synthetic_only']),scoringPerformed:z.boolean(),
 releaseGatePassed:z.literal(false),activationAllowed:z.literal(false),deployable:z.literal(false)}).strict();
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?
 '{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
export const registrationDigest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const same=(a,b,why)=>assert.equal(registrationDigest(a),registrationDigest(b),why);
const scope=v=>v.map(({leagueId,editionKey})=>({leagueId,editionKey})).sort((a,b)=>BigInt(a.leagueId)<BigInt(b.leagueId)?-1:1);
const unique=(xs,why)=>assert.equal(new Set(xs).size,xs.length,why);
export function prepareRegistration(raw,recordedAt){
 const plan=RegistrationPlanSchema.parse(raw);Time.parse(recordedAt);
 const w=plan.window,day=86400000;
 assert.equal(Date.parse(w.until)-Date.parse(w.from),28*day,'window_must_be_28_days');
 assert.equal(Date.parse(w.assessmentAt)-Date.parse(w.until),7*day,'grace_must_be_7_days');
 assert(recordedAt<w.from,'registration_not_before_window');assert(plan.executable.capturedAt<=recordedAt,'executable_after_registration');
 unique(plan.scope.map(s=>s.leagueId),'duplicate_league');unique(plan.scope.map(s=>s.editionKey),'duplicate_edition');
 for(const s of plan.scope){assert(s.evidenceObservedAt<=recordedAt,'evidence_after_registration');assert(recordedAt<s.earliestSeriesAt,'series_already_started');}
 for(const path of requiredRegistrationCode)assert(plan.executable.code[path],'required_executable_missing');
 const body={format:'conditional-registration-contract-v1',plan,recordedAt,clockBasis:'synthetic_injected_clock',
  realRegistration:false,realEvaluationAllowed:false,collectionAllowed:false,deployable:false};
 return freeze({...body,fingerprint:registrationDigest(body)});
}
export function verifyRegistration(raw){
 const reconstructed=prepareRegistration(raw.plan,raw.recordedAt);same(raw,reconstructed,'registration_changed');return reconstructed;
}
export function bindAssessment(rawRegistration,rawExecution,previous,reason,recordedAt){
 const registration=verifyRegistration(rawRegistration),execution=AssessmentBindingSchema.parse(rawExecution),p=registration.plan;
 Time.parse(recordedAt);
 same(execution.scope.slice().sort((a,b)=>BigInt(a.leagueId)<BigInt(b.leagueId)?-1:1),scope(p.scope),'scope_changed');
 same(execution.window,{fromAt:p.window.from,until:p.window.until},'window_changed');
 for(const field of ['policySha256','candidateSha256'])assert.equal(execution[field],p[field],field+'_changed');
 assert.equal(execution.exposureSha256,p.exposure.sha256,'exposure_changed');same(execution.code,p.executable.code,'executable_changed');
 assert.equal(execution.environmentSha256,p.executable.environmentSha256,'environment_changed');
 const {assessedAt,...schedule}=execution.schedule;
 same(schedule,{registeredAt:registration.recordedAt,...p.window},'schedule_changed');
 assert(assessedAt>=p.window.assessmentAt&&assessedAt<=recordedAt,'assessment_not_due_or_future');
 let revision=1,parentSha256=null,correctionReason=null;
 if(previous){
  const {fingerprint,...body}=previous;assert.equal(registrationDigest(body),fingerprint,'previous_changed');
  assert.equal(previous.registrationSha256,registration.fingerprint,'foreign_previous_registration');
  assert(recordedAt>=previous.recordedAt&&assessedAt>=previous.execution.schedule.assessedAt,'correction_clock_regression');
  assert(execution.reportSha256!==previous.execution.reportSha256&&execution.manifestSha256!==previous.execution.manifestSha256,'duplicate_assessment');
  correctionReason=z.string().trim().min(10).max(1000).parse(reason);revision=previous.revision+1;parentSha256=previous.fingerprint;
 }else assert.equal(reason,null,'first_result_has_correction_reason');
 const body={format:'conditional-assessment-commit-v1',registrationSha256:registration.fingerprint,revision,parentSha256,correctionReason,
  recordedAt,execution,clockBasis:'synthetic_injected_clock',firstResultImmutable:true,realEvaluationAllowed:false,deployable:false};
 return freeze({...body,fingerprint:registrationDigest(body)});
}
export function verifyAssessmentChain(registration,rows){
 verifyRegistration(registration);assert(Array.isArray(rows)&&rows.length<=1000,'chain_limit');let previous=null;
 const reports=new Set(),manifests=new Set();
 for(const row of rows){
  assert(!reports.has(row.execution.reportSha256)&&!manifests.has(row.execution.manifestSha256),'reused_assessment');
  const expected=bindAssessment(registration,row.execution,previous,row.correctionReason,row.recordedAt);same(row,expected,'chain_changed');
  reports.add(row.execution.reportSha256);manifests.add(row.execution.manifestSha256);previous=row;
 }
 return rows;
}
