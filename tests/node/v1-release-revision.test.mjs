import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareReleaseRevision,writeReleaseRevision,readReleaseRevision} from '../../scripts/lib/v1-release-revision.mjs';
import {V1_RELEASE_QUALITY_POLICY} from '../../packages/prediction/dist/v1-quality-policy.js';
import {canonicalContextJson} from '../../packages/db/dist/temporal.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
const policySha=sha(canonicalContextJson(V1_RELEASE_QUALITY_POLICY));
const now='2099-11-06T12:00:00.000Z';
// Synthetic metadata only: no real event, map, outcome or model evaluation.
function fixture(){
 const event=(n,id)=>({eventKey:'synthetic-main-'+n,name:'Synthetic Main '+n,provider:'opendota',leagueId:id,catalogueName:'Synthetic Main '+n,stage:'main_event',fromAt:`2099-${n===1?'11-20':'12-02'}T00:00:00.000Z`,until:`2099-${n===1?'11-30':'12-14'}T00:00:00.000Z`,tierDecision:{basis:'reviewed_event_scope',sourceUrl:'https://example.org/organizer',reviewedAt:'2099-11-06T10:00:00.000Z',rationale:'Synthetic reviewed main event fixture, not real coverage.'},scheduleSourceUrl:'https://example.org/schedule'});
 const old={request:{warmupFromAt:'2098-01-01T00:00:00.000Z',developmentDatasetSha256:'a'.repeat(64)},qualityPolicy:V1_RELEASE_QUALITY_POLICY};
 const planText=JSON.stringify(old),previous={planText,planSha256:sha(planText)};
 const intent={schemaVersion:1,format:'v1-release-revision-intent-v1',revisionKey:'synthetic-two-events',recordedAt:'2099-11-06T11:00:00.000Z',supersedesPlanSha256:previous.planSha256,qualityPolicySha256:policySha,oldPlanUse:'archive_only_no_release_selection',reason:'Synthetic previous event cannot meet registered sample size.',
  request:{schemaVersion:1,policyVersion:'conditional-elo-tier1-release-v1',evaluationBasis:'future_window_conditional_lineups',warmupFromAt:old.request.warmupFromAt,snapshotAt:'2099-12-16T00:00:00.000Z',maxInventoryMaps:5000,developmentDatasetSha256:'a'.repeat(64),events:[event(1,'100'),event(2,null)]}};
 const catalogue=rows=>{const rawBody=JSON.stringify(rows);return {source:{provider:'opendota',endpoint:'/leagues',fetchedAt:'2099-11-06T11:30:00.000Z',knownAt:null,payloadSha256:sha(rawBody)},rawBody};};
 const rows=[{leagueid:100,name:'Synthetic Main 1',tier:'professional'},{leagueid:200,name:'Synthetic Main 2',tier:'premium'}];
 const check=(capture=catalogue(rows),at=now)=>prepareReleaseRevision(intent,previous,capture,at);
 return {intent,previous,catalogue,rows,check};
}
test('missing main ID remains pending; qualifiers do not become the release event',()=>{
 const f=fixture(),result=f.check(f.catalogue([f.rows[0],{leagueid:201,name:'Synthetic Main 2 Qualifiers',tier:'professional'}]));
 assert.equal(result.status,'awaiting_event_binding');assert.equal(result.request,null);assert.equal(result.events[1].reason,'MAIN_EVENT_NOT_FOUND');
 assert.equal(result.registrationPerformed,false);assert.equal(result.teamAWinProbability,null);
});
test('unique exact main metadata prepares the existing request contract without registering or relaxing policy',()=>{
 const f=fixture(),result=f.check();assert.equal(result.status,'ready_to_register');assert.equal(result.request.events[1].leagueId,'200');
 assert.equal(result.request.snapshotAt,f.intent.request.snapshotAt);assert.equal(result.qualityPolicySha256,policySha);
 assert.equal(result.request.maxInventoryMaps,5000);assert.equal(result.deployable,false);assert.equal(result.registrationPerformed,false);
 assert.deepEqual(f.intent.request.events.map(e=>e.leagueId),['100',null]);
});
test('a pinned qualifier ID cannot silently fall back to a different main ID',()=>{
 const f=fixture();f.intent.request.events[1].leagueId='201';const result=f.check(f.catalogue([...f.rows,{leagueid:201,name:'Synthetic Main 2 Qualifiers',tier:'professional'}]));
 assert.equal(result.status,'awaiting_event_binding');assert.equal(result.events[1].reason,'PINNED_EVENT_MISMATCH');assert.equal(result.request,null);
});
test('ambiguous IDs and duplicate catalogue rows cannot be selected by order',()=>{
 for(const duplicate of [{leagueid:202,name:'Synthetic Main 2',tier:'professional'},{leagueid:200,name:'Synthetic Main 2',tier:'premium'}]){
  const f=fixture(),result=f.check(f.catalogue([...f.rows,duplicate]));assert.equal(result.request,null);assert.equal(result.events[1].reason,'AMBIGUOUS_MAIN_EVENT');
 }
});
test('qualifier or Division 2 naming in intent is rejected before binding',()=>{
 for(const name of ['Synthetic Main 2 Qualifiers','DreamLeague Division 2 Season 5']){
  const f=fixture();f.intent.request.events[1].catalogueName=name;assert.throws(()=>f.check(),/revision_intent_invalid/);
 }
});
test('tampered catalogue, stale capture and future evidence fail closed',()=>{
 const f=fixture(),c=f.catalogue(f.rows);c.rawBody+=' ';assert.throws(()=>f.check(c),/revision_catalogue_hash/);
 const stale=f.catalogue(f.rows);stale.source.fetchedAt='2099-11-05T11:59:59.999Z';assert.throws(()=>f.check(stale),/revision_catalogue_stale/);
 const future=f.catalogue(f.rows);future.source.fetchedAt='2099-11-06T12:00:00.001Z';assert.throws(()=>f.check(future),/revision_future_evidence/);
});
test('exact first event boundary refuses registration preparation even with all IDs',()=>{
 const f=fixture();assert.throws(()=>f.check(undefined,'2099-11-20T00:00:00.000Z'),/revision_registration_deadline/);
});
test('previous-plan substitution, quality changes and historical window changes are rejected',()=>{
 let f=fixture();f.intent.supersedesPlanSha256='b'.repeat(64);assert.throws(()=>f.check(),/revision_previous_plan/);
 f=fixture();f.intent.qualityPolicySha256='b'.repeat(64);assert.throws(()=>f.check(),/revision_policy_changed/);
 f=fixture();f.intent.request.warmupFromAt='2097-01-01T00:00:00.000Z';assert.throws(()=>f.check(),/revision_history_changed/);
 f=fixture();f.intent.request.developmentDatasetSha256='b'.repeat(64);assert.throws(()=>f.check(),/revision_history_changed/);
});
test('invalid timestamps, duplicate scopes and hidden intent fields are rejected',()=>{
 for(const mutate of [f=>f.intent.recordedAt='2099-11-06T12:00:00.001Z',f=>f.intent.request.events[1].eventKey=f.intent.request.events[0].eventKey,
  f=>f.intent.request.snapshotAt=f.intent.request.events[1].until,f=>f.intent.policyOverride={minSeries:1}]){
  const f=fixture();mutate(f);assert.throws(()=>f.check(),/revision_intent_invalid|revision_future_evidence/);
 }
});
test('exclusive output contains matching request/catalogue hashes and never overwrites earlier files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dota-release-revision-'));t.after(()=>{assert.ok(root.startsWith(resolve(tmpdir())+sep+'dota-release-revision-'));return rm(root,{recursive:true,force:true});});
 const f=fixture(),result=f.check(),out=join(root,'prepared');await writeReleaseRevision(result,out);
 const request=JSON.parse(await readFile(join(out,'request.json'),'utf8'));assert.equal(request.catalogueSha256,sha(await readFile(join(out,'catalogue.json'))));
 await assert.rejects(writeReleaseRevision(result,out),/EEXIST/);assert.deepEqual(await readdir(out),['catalogue.json','preparation.json','request.json']);
 const pending=f.check(f.catalogue([f.rows[0]]));await assert.rejects(writeReleaseRevision(pending,join(root,'pending')),/revision_not_ready/);
 assert.deepEqual(await readdir(root),['prepared']);
});
test('file preparation checks exact config/intent SHA and verifies the previous executable bundle',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dota-release-inputs-'));t.after(()=>{assert.ok(root.startsWith(resolve(tmpdir())+sep+'dota-release-inputs-'));return rm(root,{recursive:true,force:true});});
 const f=fixture(),save=async(name,value)=>{const path=join(root,name),bytes=JSON.stringify(value);await writeFile(path,bytes);return {path,sha256:sha(bytes)};};
 const intent=await save('intent.json',f.intent),catalogue=await save('catalogue.json',f.catalogue(f.rows));
 const previousBundle={path:'synthetic-bundle',configSha256:'c'.repeat(64),freezeSha256:'d'.repeat(64)};
 const config=await save('inputs.json',{schemaVersion:1,intent,catalogue,previousBundle});let calls=0;
 const verifyBundle=async(...args)=>{calls++;assert.deepEqual(args,Object.values(previousBundle));return f.previous;};
 const deps={verifyBundle,clock:()=>now};
 const result=await readReleaseRevision(config.path,config.sha256,deps);assert.equal(result.status,'ready_to_register');assert.equal(calls,1);
 await assert.rejects(readReleaseRevision(config.path,'e'.repeat(64),deps),/discovery_file_sha_mismatch/);
 await writeFile(intent.path,JSON.stringify({...f.intent,reason:'Tampered fixture, must not reach verification.'}));
 await assert.rejects(readReleaseRevision(config.path,config.sha256,deps),/discovery_file_sha_mismatch/);assert.equal(calls,1);
});
test('transport annotations are omitted from the plan catalogue and cannot alter its source hash',()=>{
 const f=fixture(),capture=f.catalogue(f.rows);capture.source.attempts=1;capture.source.adapterVersion='synthetic-adapter';
 const result=f.check(capture);assert.equal(result.status,'ready_to_register');assert.equal(result.catalogue.source.attempts,undefined);
 assert.equal(result.request.catalogueSha256,sha(JSON.stringify(result.catalogue,null,2)+'\n'));
});
