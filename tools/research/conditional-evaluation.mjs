/** Authenticated local joins only. No inference, labels in features, registration or release. */
import assert from 'node:assert/strict';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {parseSource} from '../../packages/ingestion/dist/quality.js';
import {EnrollmentInputSchema,verifyConditionalEnrollment} from './conditional-enrollment.mjs';
import {ConditionalSourceArchiveSchema,bindConditionalFutureSources} from './conditional-future-source-binding.mjs';
import {ConditionalHoldoutInputSchema,conditionalDigest} from '../../.tools/s304-future-runtime/conditional-future-holdout.mjs';
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const Series=z.string().refine(v=>{try{const p=JSON.parse(v);return p.length===2&&p[0]==='opendota'&&Id.safeParse(p[1]).success&&JSON.stringify(p)===v;}catch{return false;}});
const Exposure=z.object({sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),mapIds:z.array(Id).max(100000),seriesKeys:z.array(Series).max(100000)}).strict();
const Input=z.object({enrollmentInput:EnrollmentInputSchema,featureInput:ConditionalHoldoutInputSchema,
 archive:ConditionalSourceArchiveSchema,requiredExposure:Exposure}).strict();
const numeric=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const sameSet=(a,b,why)=>assert.deepEqual([...a].sort(),[...b].sort(),why);
const us=t=>String(BigInt(Date.parse(t))*1000n);
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};

export function buildConditionalEvaluationBundle(raw){
 const {enrollmentInput:e,featureInput:f,archive,requiredExposure:exposure}=Input.parse(raw);
 assert.equal(e.syntheticOnly,f.syntheticOnly,'synthetic_input_mismatch');
 assert.equal(e.syntheticOnly,archive.syntheticOnly,'synthetic_archive_mismatch');
 assert.deepEqual(f.window,{fromAtUs:us(e.window.fromAt),untilAtUs:us(e.window.until)},'window_mismatch');
 sameSet(f.eventIds,e.scope.map(s=>s.leagueId),'event_scope_mismatch');
 sameSet(f.cases.map(c=>c.target.matchId),e.preparedTargetIds,'prepared_target_mismatch');
 for(const key of ['mapIds','seriesKeys']){
  sameSet(f.exposure[key],e.exposure[key],'exposure_mismatch');
  assert.equal(new Set(exposure[key]).size,exposure[key].length,'duplicate_required_exposure');
  assert(exposure[key].every(id=>f.exposure[key].includes(id)),'frozen_exposure_dropped');
 }
 assert.equal(f.exposure.sourceSha256,exposure.sourceSha256,'exposure_sha_mismatch');
 // Recompute both boundaries. Caller-provided completion/paired flags are not accepted.
 const enrollment=verifyConditionalEnrollment(e,archive),bound=bindConditionalFutureSources(f,archive);
 for(const s of f.series){
  const registered=enrollment.series.find(r=>r.seriesKey===s.seriesKey);
  if(registered){
   assert.equal(s.eventId,registered.leagueId,'series_event_mismatch');sameSet(s.mapIds,registered.mapIds,'series_members_mismatch');
   assert.equal(s.completedAtUs,registered.completedAt===null?null:us(registered.completedAt),'series_completion_mismatch');
  }
 }
 const sourceRows=new Map(bound.sourceLedger.rows.map(r=>[r.matchId,r])),features=new Map(bound.features.rows.map(r=>[r.matchId,r]));
 const labels=new Map(bound.labels.rows.map(r=>[r.matchId,r])),targets=new Map(f.cases.map(c=>[c.target.matchId,c.target]));
 const blockers=[...enrollment.reasons];
 if(enrollment.knownPossibleMaps>300)blockers.push('TARGET_BUDGET_EXCEEDED');
 const rows=enrollment.rows.map(r=>{
  const feature=features.get(r.matchId),label=labels.get(r.matchId),source=sourceRows.get(r.matchId),target=targets.get(r.matchId);
  const reasons=[...r.reasons,...(feature?.reasons??['FEATURE_INPUT_MISSING']),...(source?.reasons??[])];
  if(!r.eligible)reasons.push('ENROLLMENT_NOT_ELIGIBLE');
  if(!label)reasons.push('VERIFIED_LABEL_MISSING');
  if(source?.status!=='source_bound')reasons.push('FEATURE_SOURCE_NOT_BOUND');
  if(!feature?.pairedEligible||!feature.inputs)reasons.push('PAIRED_FEATURES_UNAVAILABLE');
  if(label&&target){
   assert.equal(label.seriesKey,target.seriesKey,'label_series_mismatch');assert.equal(label.eventId,target.eventId,'label_event_mismatch');
   assert.equal(label.startedAtUs,target.startedAtUs,'label_cutoff_mismatch');
   assert.equal(label.payloadSha256,target.sourceSha256,'label_receipt_mismatch');
   assert.equal(label.teamASide,BigInt(target.radiantTeamId)<BigInt(target.direTeamId)?'radiant':'dire','label_side_mismatch');
  }
  const inputs=feature?.inputs;
  if(inputs)assert(Object.values(inputs).every(Number.isFinite),'nonfinite_feature');
  return {matchId:r.matchId,seriesKey:r.seriesKey,eventId:r.metadata.leagueid,startedAt:r.startedAt,
   inDenominator:r.verifiedProMap,possibleTarget:r.denominatorCandidate,verifiedLabelAvailable:!!label,
   pairedEligible:!blockers.length&&r.verifiedProMap&&reasons.length===0,reasons:[...new Set(reasons)].sort()};
 });
 const badSeries=new Set(rows.filter(r=>!r.pairedEligible).map(r=>r.seriesKey).filter(Boolean));
 for(const row of rows)if(row.seriesKey&&badSeries.has(row.seriesKey)){
  row.pairedEligible=false;row.reasons=[...new Set([...row.reasons,'SERIES_HAS_UNAVAILABLE_MEMBER'])].sort();
 }
 rows.sort((a,b)=>numeric(a.matchId,b.matchId));
 const paired=rows.filter(r=>r.pairedEligible),denominator=enrollment.verifiedProDenominator;
 const selectedFeatures=paired.map(r=>{
  const feature=features.get(r.matchId),snapshot=feature.feature,hero=snapshot.heroSnapshot;
  const players=[...hero.teamA,...hero.teamB];assert.equal(players.length,10,'player_feature_count');
  const receipt=archive.receipts.find(x=>x.matchId===r.matchId);
  const parsed=parseSource({rawBody:receipt.rawBody,source:{provider:'opendota',adapterVersion:receipt.adapterVersion,
   endpoint:receipt.endpoint,fetchedAt:receipt.fetchedAt,knownAt:null,payloadSha256:receipt.bodySha256}},r.matchId);
  const patch=parsed.match?.patch;
  return {matchId:r.matchId,seriesKey:r.seriesKey,eventId:r.eventId,cutoffAtUs:feature.startedAtUs,
   inputs:{...feature.inputs},encoded:{H0:[feature.inputs.eloLogit],H1:[...snapshot.encoded.H1],H2:[...snapshot.encoded.H2]},
   featureFingerprint:snapshot.fingerprint,
   annotations:{provider:'opendota',leagueId:r.eventId,providerPatchId:patch==null?null:String(patch),canonicalPatchId:snapshot.target.canonicalPatchId,
    monthUTC:r.startedAt.slice(0,7),hasUnknownHeroHistory:players.some(p=>p.heroUnknownMaps>0),hasZeroObservedHeroCount:players.some(p=>p.nRaw===0)},
   warnings:snapshot.warnings.concat(hero.warnings)};
 });
 const selectedLabels=paired.map(r=>({...labels.get(r.matchId)}));
 const common={syntheticOnly:e.syntheticOnly,evaluationBasis:'conditional_reconstructed',registrationAllowed:false,
  collectionAllowed:false,evaluationAllowed:false,scoringPerformed:false,independentTestCompleted:false,deployable:false};
 const cohort={format:'conditional-evaluation-cohort-v1',...common,status:!blockers.length&&paired.length?'prepared_local_inputs':'insufficient',
  window:e.window,scope:e.scope,denominatorComplete:enrollment.denominatorComplete,
  denominatorBasis:enrollment.basis,providerCompletenessIndependentlyProven:false,
  counts:{knownPossibleMaps:enrollment.knownPossibleMaps,verifiedProDenominator:denominator,pairedMaps:paired.length,
   pairedSeries:new Set(paired.map(r=>r.seriesKey)).size,verifiedLabels:bound.labels.rows.length},
  pairedCoverage:enrollment.denominatorComplete&&!blockers.length&&denominator?paired.length/denominator:null,
  pairedMapIds:paired.map(r=>r.matchId),variants:['H0','H1_raw','H1_cal','H2_raw','H2_cal'],
  reasons:[...new Set(blockers)].sort(),rows,
  warnings:['UNREGISTERED_LOCAL_PREPARATION','REVIEWED_REGISTER_IS_TRUST_BOUNDARY','NOT_PROSPECTIVE_PERFORMANCE',
   'CONDITIONAL_EVALUATOR_ADAPTER_PENDING']};
 return freeze({cohort,features:{format:'conditional-evaluation-features-v1',...common,rows:selectedFeatures},
  labels:{format:'conditional-evaluation-labels-v1',...common,rows:selectedLabels},
  audit:{format:'conditional-evaluation-audit-v1',...common,enrollmentFingerprint:enrollment.fingerprint,
   holdoutFingerprint:bound.features.fingerprint,sourceLedger:bound.sourceLedger,
   allVerifiedLabelsFingerprint:conditionalDigest(bound.labels),
   inputFingerprints:{enrollment:conditionalDigest(e),features:conditionalDigest(f),archive:conditionalDigest(archive),exposure:conditionalDigest(exposure)}}});
}
