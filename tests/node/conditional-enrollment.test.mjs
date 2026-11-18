import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyConditionalEnrollment as verify} from '../../tools/research/conditional-enrollment.mjs';
import {enrollmentFixture,editRegister,editPage} from '../fixtures/conditional-enrollment.mjs';
import {sourceSha} from '../../tools/research/conditional-future-source-binding.mjs';
const run=f=>verify(f.input,f.archive);
test('cross-checks reviewed main edition, retained pages and verified maps without publishing',()=>{
 const f=enrollmentFixture(),before=structuredClone(f),r=run(f);assert.equal(r.status,'reviewed_inventory_consistent');
 assert.equal(r.denominatorComplete,true);assert.equal(r.verifiedProDenominator,2);assert.equal(r.eligibleMaps,2);assert.equal(r.eligibleCoverage,1);
 assert.equal(r.registrationAllowed,false);assert.equal(r.deployable,false);assert.equal(r.providerCompletenessIndependentlyProven,false);assert.deepEqual(f,before);
});
test('a missing prepared row stays in the known denominator and excludes the whole series',()=>{
 const f=enrollmentFixture();const missing=f.input.preparedTargetIds.pop(),r=run(f);
 assert.equal(r.verifiedProDenominator,2);assert.equal(r.denominatorComplete,true);assert.equal(r.eligibleMaps,0);assert.equal(r.eligibleCoverage,0);
 assert(r.rows.find(x=>x.matchId===missing).reasons.includes('FEATURE_INPUT_MISSING'));
});
for(const [name,change,reason] of [
 ['no register',f=>{f.input.registers=[];},'EVENT_REGISTER_MISSING'],
 ['open event',f=>editRegister(f,r=>r.closed=false),'EVENT_REGISTER_NOT_CLOSED'],
 ['qualifier',f=>editRegister(f,r=>r.stage='qualifier'),'EVENT_EDITION_MISMATCH'],
 ['wrong edition',f=>editRegister(f,r=>r.editionKey='another'),'EVENT_EDITION_MISMATCH'],
 ['missing league response',f=>{f.input.pages=[];},'LEAGUE_RESPONSE_MISSING'],
 ['unplayed series',f=>editRegister(f,r=>r.series[0].state='scheduled'),'SERIES_NOT_CLOSED'],
 ['unknown end',f=>editRegister(f,r=>r.series[0].completedAt=null),'SERIES_COMPLETION_UNKNOWN'],
 ['missing listed member',f=>editRegister(f,r=>r.series[0].mapIds.push('9007199254741200')),'MAP_SOURCE_UNVERIFIED'],
 ['map omitted from register',f=>editRegister(f,r=>r.series[0].mapIds.pop()),'UNREGISTERED_OBSERVED_MAP'],
 ['page missing map',f=>editPage(f,p=>p.pop()),'MAP_MISSING_FROM_LEAGUE_RESPONSE'],
 ['premature review',f=>{f.input.registers[0].reviewedAt=f.input.window.fromAt;},'REGISTER_COMPLETION_AFTER_REVIEW'],
])test(name+' is insufficient, not a smaller convenient sample',()=>{
 const f=enrollmentFixture();change(f);const r=run(f);assert.equal(r.denominatorComplete,false);assert.equal(r.eligibleCoverage,null);
 assert(r.reasons.includes(reason)||r.rows.some(row=>row.reasons.includes(reason)));assert(r.knownPossibleMaps>=2);
});
test('metadata conflicts and endpoint mismatch preserve the observed ID',()=>{
 const f=enrollmentFixture();editPage(f,p=>p[0].leagueid='301');const r=run(f);
 assert.equal(r.knownPossibleMaps,2);assert.equal(r.denominatorComplete,false);assert(r.rows[0].reasons.includes('METADATA_CONFLICT'));
});
test('whole-series window crossing is excluded while outside maps stay outside denominator',()=>{
 const f=enrollmentFixture();f.input.window.fromAt=new Date(Date.parse(f.input.window.fromAt)+1000).toISOString();
 const r=run(f);assert.equal(r.verifiedProDenominator,1);assert.equal(r.eligibleMaps,0);assert(r.series[0].reasons.includes('SERIES_OUTSIDE_WINDOW'));
});
test('exposure exclusion does not shrink the verified denominator',()=>{
 const f=enrollmentFixture();f.input.exposure.mapIds.push(f.input.preparedTargetIds[0]);const r=run(f);
 assert.equal(r.verifiedProDenominator,2);assert.equal(r.eligibleMaps,0);assert.equal(r.eligibleCoverage,0);
});
test('cancelled series without maps is administrative only, finished empty series is incomplete',()=>{
 const f=enrollmentFixture();editRegister(f,r=>r.series.push({nativeSeriesId:'100',state:'cancelled',mapIds:[],completedAt:null}));
 assert.equal(run(f).verifiedProDenominator,2);assert.equal(run(f).administrativeSeries,1);
 editRegister(f,r=>r.series[1].state='finished');assert.equal(run(f).denominatorComplete,false);
});
test('empty page never proves a whole event, and empty reviewed universe has null rate',()=>{
 const f=enrollmentFixture();editPage(f,p=>p.splice(0));f.input.registers=[];assert.equal(run(f).denominatorComplete,false);
 f.archive.receipts=[];f.archive.targetMapIds=[];f.archive.historyMapIds=[];f.input.preparedTargetIds=[];
 assert.equal(run(f).eligibleCoverage,null);
});
test('cursor chain is reconstructed, not trusted from page counters',()=>{
 const f=enrollmentFixture(),data=JSON.parse(f.input.pages[0].rawBody),min=data.map(r=>r.match_id).sort()[0];
 const page=(sequence,endpoint,rows)=>({status:'captured',sequence,endpoint,fetchedAt:f.input.snapshotAt,rawBody:JSON.stringify(rows),payloadSha256:sourceSha(JSON.stringify(rows))});
 f.input.pages.unshift(page(0,'/proMatches',data),page(1,'/proMatches?less_than_match_id='+min,[]));f.input.pages[2].sequence=2;
 assert.equal(run(f).trace.proPages,'exhausted');
 f.input.pages[1].endpoint='/proMatches?less_than_match_id=1';assert.throws(()=>run(f),/cursor/);
});
test('bounded pro feed is reported separately from the reviewed event register',()=>{
 const f=enrollmentFixture(),page=structuredClone(f.input.pages[0]);page.endpoint='/proMatches';f.input.pages.unshift(page);f.input.pages[1].sequence=1;
 const r=run(f);assert.equal(r.trace.proPages,'bounded');assert.equal(r.denominatorComplete,true);
});
test('byte tampering, duplicate series members and synthetic mixing fail closed',()=>{
 for(const mutate of [f=>f.input.pages[0].rawBody+=' ',f=>f.input.registers[0].rawBody+=' ',
  f=>editRegister(f,r=>r.series[0].mapIds.push(r.series[0].mapIds[0])),f=>f.input.syntheticOnly=false]){
  const f=enrollmentFixture();mutate(f);assert.throws(()=>run(f));
 }
});
test('failed pro request is not an exhausted successful feed',()=>{
 const f=enrollmentFixture();f.input.pages.unshift({status:'failed',sequence:0,endpoint:'/proMatches',failedAt:f.input.snapshotAt,code:'source_rate_limited'});
 f.input.pages[1].sequence=1;const r=run(f);assert.equal(r.trace.proPages,'failed');assert.equal(r.denominatorComplete,false);
});
test('a false series completion contradicting verified map times cannot certify completeness',()=>{
 const f=enrollmentFixture();editRegister(f,r=>r.series[0].completedAt=f.input.window.fromAt);
 const r=run(f);assert.equal(r.denominatorComplete,false);assert(r.reasons.includes('SERIES_COMPLETION_CONFLICT'));
});
test('earlier retained pages are reused if the closed reviewed register still matches every map',()=>{
 const f=enrollmentFixture();f.input.pages[0].fetchedAt=new Date(Date.parse(f.input.window.until)-1000).toISOString();
 const r=run(f);assert.equal(r.denominatorComplete,true);assert(r.warnings.includes('RETAINED_PAGES_PREDATE_WINDOW_END'));
});
