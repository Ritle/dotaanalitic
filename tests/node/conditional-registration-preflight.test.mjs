import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {inspectConditionalRegistrationPreflight as inspect,preflightSha as sha,loadPreflightSources} from '../../tools/research/conditional-registration-preflight.mjs';
const root=resolve(import.meta.dirname,'../..');
const policy=JSON.parse(await readFile(join(root,'tools/research/player-hero-conditional-future-policy.json'),'utf8'));
const time='2026-11-15T01:00:00.000Z';
function catalogue(data=[{leagueid:'20208',name:'BLAST SLAM IX',tier:'professional'},{leagueid:'20359',name:'DreamLeague Season 30 Qualifiers',tier:'professional'}]){
 const rawBody=JSON.stringify(data);return {data,rawBody,source:{provider:'opendota',endpoint:'/leagues',fetchedAt:time,knownAt:null,payloadSha256:sha(rawBody)}};
}
function row(id='100',league='DreamLeague',series='Division 2 season 5 2026'){
 return {providerMatchId:id,name:null,status:'not_started',scheduledAt:'2026-11-21T10:00:00.000Z',
 tournament:{providerTournamentId:'20',name:'Playoffs'},league:{providerLeagueId:'10',name:league},
 eventSeries:{providerEventSeriesId:'30',name:series},seriesBestOf:3,opponents:[]};
}
function page(data=[],n=1){return {page:n,observation:{data,source:{provider:'pandascore',endpoint:`/dota2/matches/upcoming?sort=scheduled_at,id&page=${n}&per_page=20`,fetchedAt:time,knownAt:null,payloadSha256:'a'.repeat(64)}}};}
const input=()=>({checkedAt:time,catalogue:catalogue(),pages:[page([row()])]});

test('provider record is a candidate only; qualifiers and Division 2 do not become main-event IDs',()=>{
 const result=inspect(input(),policy);
 assert.equal(result.scope[0].openDota.candidates[0].leagueId,'20208');
 assert.equal(result.scope[0].verifiedNativeLeagueId,null);assert.equal(result.scope[0].openDota.bindingVerified,false);
 assert.equal(result.scope[1].openDota.candidates.length,0);assert.equal(result.scope[1].openDota.excludedRelated[0].leagueId,'20359');
 assert.equal(result.scope[1].pandaScore.matchIds.length,0);assert.equal(result.scope[1].pandaScore.excludedRelatedMatches,1);
 assert.equal(result.registrationPlan,null);assert.equal(result.registrationReady,false);assert.equal(result.deployable,false);
});
test('short final page means observed endpoint end, never an atomic or complete future map denominator',()=>{
 const result=inspect(input(),policy);
 assert.equal(result.schedule.scan,'endpoint_end_observed');assert.equal(result.schedule.atomicSnapshot,false);
 assert.equal(result.schedule.futureDenominatorComplete,false);assert.equal(result.scope[0].pandaScore.status,'not_observed_in_scan');
});
test('full first page and missing provider cannot assert that a tournament is absent',()=>{
 const data=Array.from({length:20},(_,i)=>row(String(i+1),'Other','Other'));
 const result=inspect({...input(),catalogue:null,pages:[page(data)]},policy);
 assert.equal(result.schedule.scan,'partial');assert.equal(result.scope[0].openDota.status,'unknown_source_unavailable');
 assert.equal(result.scope[0].pandaScore.status,'unknown_partial_or_unavailable_scan');
 assert.equal(inspect({...input(),pages:[]},policy).schedule.scan,'unavailable');
});
test('main-event schedule rows remain candidate bindings with an observed, not proven earliest start',()=>{
 const result=inspect({...input(),pages:[page([row('1','DreamLeague','Season 30 2026'),row('2','BLAST Slam','IX 2026')])]},policy);
 assert.deepEqual(result.scope[1].pandaScore.tournamentIds,['20']);assert.deepEqual(result.scope[0].pandaScore.matchIds,['2']);
 assert.equal(result.scope[1].pandaScore.firstListedSeriesAt,'2026-11-21T10:00:00.000Z');
 assert.equal(result.scope[1].earliestVerifiedSeriesAt,null);assert.equal(result.scope[1].pandaScore.bindingVerified,false);
});
test('page gaps, repeated matches, wrong endpoints and pages after end fail closed',()=>{
 const full=Array.from({length:20},(_,i)=>row(String(i+1)));
 for(const pages of [[page([],2)],[page(full),page([row('1')],2)],[page([]),page([],2)]])assert.throws(()=>inspect({...input(),pages},policy));
 const bad=page([]);bad.observation.source.endpoint='/dota2/matches/past';assert.throws(()=>inspect({...input(),pages:[bad]},policy));
});
test('raw catalogue SHA and parsed projection must agree; duplicate native IDs are rejected',()=>{
 const changed=catalogue();changed.data[0].leagueid='999';assert.throws(()=>inspect({...input(),catalogue:changed},policy),/projection_changed/);
 const damaged=catalogue();damaged.rawBody+=' ';assert.throws(()=>inspect({...input(),catalogue:damaged},policy),/raw_hash/);
 assert.throws(()=>inspect({...input(),catalogue:catalogue([{leagueid:'1',name:'A'},{leagueid:'1',name:'B'}])},policy),/duplicate_catalogue_id/);
});
test('future observations and caller authorization switches are rejected; deadline never moves',()=>{
 assert.throws(()=>inspect({...input(),checkedAt:'2026-11-14T00:00:00.000Z'},policy),/future_catalogue/);
 assert.throws(()=>inspect({...input(),registrationReady:true},policy));
 const result=inspect({...input(),checkedAt:policy.proposedRegistration.decisionDeadline},policy);
 assert(result.registrationBlockers.includes('REGISTRATION_DECISION_DEADLINE_PASSED'));
 assert.equal(result.proposedWindow.until,policy.proposedRegistration.until);assert.equal(result.collectionAllowed,false);
});
test('immutable source manifest, bounded private paths and CLI refuse tampering and overwrite',async()=>{
 const directory=await mkdtemp(join(root,'.tools/preflight-test-'));
 try{
  const source=JSON.stringify(catalogue()),sourcePath=join(directory,'catalogue.json');await writeFile(sourcePath,source);
  const manifest={format:'conditional-preflight-source-manifest-v1',createdAt:time,refs:[{name:'opendota-catalogue',path:sourcePath,sha256:sha(source)}]};
  const text=JSON.stringify(manifest),path=join(directory,'manifest.json');await writeFile(path,text);
  assert.equal((await loadPreflightSources(path,sha(text))).input.catalogue.data.length,2);
  await assert.rejects(loadPreflightSources(path,'0'.repeat(64)),/manifest_hash/);
  const run=(...args)=>spawnSync(process.execPath,['tools/research/conditional-registration-preflight.mjs',...args],{cwd:root,encoding:'utf8',timeout:60000});
  const output=join(directory,'report');const created=run('inspect',path,sha(text),output);assert.equal(created.status,0,created.stderr);
  const original=await readFile(join(output,'report.json'),'utf8');assert.equal(JSON.parse(original).registrationReady,false);
  assert.notEqual(run('inspect',path,sha(text),output).status,0);assert.equal(await readFile(join(output,'report.json'),'utf8'),original);
  await writeFile(sourcePath,'changed');await assert.rejects(loadPreflightSources(path,sha(text)),/source_hash/);
  const foreign={...manifest,refs:[{name:'opendota-catalogue',path:join(root,'package.json'),sha256:sha(await readFile(join(root,'package.json')))}]};
  const foreignText=JSON.stringify(foreign);await writeFile(path,foreignText);
  await assert.rejects(loadPreflightSources(path,sha(foreignText)),/private_path_required/);
 }finally{const r=relative(join(root,'.tools'),directory);assert(r&&!r.startsWith('..'));await rm(directory,{recursive:true,force:true});}
});
