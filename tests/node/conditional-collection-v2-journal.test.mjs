import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CollectionV2Command,replayCollectionV2} from '../../tools/research/conditional-collection-v2-journal.mjs';
import {archiveSha as sha} from '../../tools/research/conditional-blob-archive.mjs';
const id=randomUUID(),owner=randomUUID(),at='2026-11-20T00:00:00.000Z';
const registration={id,packageSha256:'a'.repeat(64),registeredAt:'2026-11-15T00:00:00.000Z',plan:{ownerUserId:owner,
 window:{from:at,until:'2026-12-18T00:00:00.000Z',assessmentAt:'2026-12-25T00:00:00.000Z'},
 collection:{maxHttpAttempts:1000,maxDailyAttempts:100},scope:[{leagueId:'90001'}]}};
const headerText=JSON.stringify({format:'conditional-collection-v2-journal',registrationId:id,registrationSha256:registration.packageSha256,
 ownerUserId:owner,archiveHeaderSha256:'b'.repeat(64),syntheticOnly:true,createdAt:at});
const header={registration_id:id,registration_sha256:registration.packageSha256,owner_user_id:owner,archive_header_sha256:'b'.repeat(64),
 synthetic_only:true,created_at:at,header_text:headerText,header_sha256:sha(headerText)};
function row(command,event,sequence=0,parent=header.header_sha256){const operation=randomUUID(),text=JSON.stringify(command),eventText=JSON.stringify({...event,sequence});
 return {registration_id:id,sequence,operation_id:operation,command_text:text,command_sha256:sha(text),parent_sha256:parent,event_text:eventText,
 recorded_at:event.at,head_sha256:sha(parent+':'+operation+':'+sha(text)+':'+eventText)};}
test('strict commands normalize UUID and reject caller timestamps/authorization, credentials and unsupported HTTP codes',()=>{
 const requestId=randomUUID();assert.equal(CollectionV2Command.parse({kind:'reserve',requestId:requestId.toUpperCase(),endpoint:'/proMatches'}).requestId,requestId);
 for(const extra of [{at},{dispatchAllowed:true}])assert.throws(()=>CollectionV2Command.parse({kind:'reserve',requestId,endpoint:'/proMatches',...extra}));
 for(const endpoint of ['/matches/0','/matches/9223372036854775808','/proMatches?api_key=secret','https://example.com'])assert.throws(()=>CollectionV2Command.parse({kind:'reserve',requestId,endpoint}));
 assert.throws(()=>CollectionV2Command.parse({kind:'fail',requestId,httpStatus:200,code:'http_error',retryAfterAt:null}));
});
test('attempt is consumed at reservation and remains pending without invented outcome',()=>{
 const requestId=randomUUID(),command={kind:'reserve',requestId,endpoint:'/leagues/90001/matches'};
 const r=row(command,{kind:'reserved',requestId,endpoint:command.endpoint,at});const result=replayCollectionV2(registration,header,[r],at);
 assert.equal(result.attempts.total,1);assert.equal(result.pendingRequest.requestId,requestId);assert.equal(result.denominatorComplete,false);assert.equal(result.dispatchAllowed,false);
});
test('foreign league, duplicate in-flight request and altered chain fail closed',()=>{
 const requestId=randomUUID();const first=row({kind:'reserve',requestId,endpoint:'/proMatches'},{kind:'reserved',requestId,endpoint:'/proMatches',at});
 const nextId=randomUUID(),second=row({kind:'reserve',requestId:nextId,endpoint:'/proMatches'},{kind:'reserved',requestId:nextId,endpoint:'/proMatches',at},1,first.head_sha256);
 assert.throws(()=>replayCollectionV2(registration,header,[first,second],at),/in_flight/);
 assert.throws(()=>replayCollectionV2(registration,header,[{...first,event_text:first.event_text+' '}],at),/hash/);
 const foreign=row({kind:'reserve',requestId,endpoint:'/leagues/3/matches'},{kind:'reserved',requestId,endpoint:'/leagues/3/matches',at});
 assert.throws(()=>replayCollectionV2(registration,header,[foreign],at),/unregistered_league/);
});
test('failed attempt keeps charge and applies Retry-After; unknown recovery requires 120 seconds',()=>{
 const requestId=randomUUID(),start=row({kind:'reserve',requestId,endpoint:'/proMatches'},{kind:'reserved',requestId,endpoint:'/proMatches',at});
 const failedAt='2026-11-20T00:00:01.000Z',retry='2026-11-20T00:05:00.000Z';
 const end=row({kind:'fail',requestId,httpStatus:429,code:'http_error',retryAfterAt:retry},
  {kind:'failed',requestId,httpStatus:429,code:'http_error',retryAfterAt:retry,at:failedAt},1,start.head_sha256);
 const result=replayCollectionV2(registration,header,[start,end],failedAt);assert.equal(result.attempts.total,1);assert.equal(result.cooldownUntil,retry);assert.equal(result.pendingRequest,null);
 const recovery=row({kind:'recover',requestId,reason:'Operator confirms unknown transport outcome'}, {kind:'recovered_unknown',requestId,at:failedAt},1,start.head_sha256);
 assert.throws(()=>replayCollectionV2(registration,header,[start,recovery],failedAt),/recovery_not_expired/);
});
test('target-map window is separate from collection cutoff; assessment equality prohibits new requests',()=>{
 const requestId=randomUUID(),command={kind:'reserve',requestId,endpoint:'/proMatches'};
 const later='2026-12-20T00:00:00.000Z';assert.equal(replayCollectionV2(registration,header,[row(command,{kind:'reserved',requestId,endpoint:'/proMatches',at:later})],later).attempts.total,1);
 const end=registration.plan.window.assessmentAt;assert.throws(()=>replayCollectionV2(registration,header,[row(command,{kind:'reserved',requestId,endpoint:'/proMatches',at:end})],end),/window_closed/);
});
