import {expect,it} from 'vitest';
import {gzipSync} from 'node:zlib';
import {archiveDigest} from '../src/valve/archive-evidence.js';
import {ArchiveEvidenceClient} from '../src/valve/archive-client.js';
import {auditHistoricalMapAccounts,teamAccountOriginal,verifyArchivedTeamAccounts} from '../src/valve/team-account-evidence.js';
const teamId='9007199254740993',original=teamAccountOriginal(teamId),stamp='20220816121930';
// Synthetic accounts only; no real identity records or training data are created.
const source=()=>({team_id:teamId,members:[{account_id:101,pro_name:'Synthetic alias',time_joined:1612296480,real_name:'private'}],
  registered_member_account_ids:[101],wins:999,member_stats:[{kills:999}]});
function snapshot(body:unknown=source(),gzip=true){
  const raw=Buffer.from(JSON.stringify(body)),bytes=gzip?gzipSync(raw):raw;
  return {original,originalLink:original,timestamp:stamp,mementoDatetime:'Tue, 16 Aug 2022 12:19:30 GMT',
    digest:archiveDigest(bytes),encoding:gzip?'gzip':'identity',bytes,fetchedAt:'2026-11-01T00:00:00.000Z'};
}
const horizon='2026-11-01T01:00:00.000Z';
const map=()=>({schemaVersion:1,mode:'live_opendota_map_account_observation',matchId:'9007199254740995',leagueId:'15728',
  startedAt:'2023-10-12T17:00:44.000Z',fetchedAt:'2026-10-31T23:00:00.000Z',knownAt:null,
  source:{endpoint:'/matches/9007199254740995',payloadSha256:'a'.repeat(64),adapterVersion:'synthetic-test'},
  players:[{playerSlot:128,accountId:'101'},{playerSlot:0,accountId:'102'}]});
it('binds Steam32 account associations to an archive and strips real names, roles and telemetry',()=>{
  const r=verifyArchivedTeamAccounts(snapshot(),teamId);
  expect(r).toMatchObject({accountNamespace:'steam32',knownByAt:'2022-08-16T12:19:30.000Z',registeredAccountIds:['101'],
    canonicalPlayersCreated:0,verifiedMapLineups:0,autoIdentityMergeEligible:false,roles:null});
  expect(r.members[0]).toMatchObject({accountId:'101',alias:'Synthetic alias',registered:true,canonicalPlayerId:null});
  expect(JSON.stringify(r)).not.toMatch(/private|real_name|member_stats|kills|wins/);
  expect(verifyArchivedTeamAccounts(snapshot(source(),false),teamId).projectionSha256).toBe(r.projectionSha256);
});
it('unknown and explicitly empty registration are distinct; empty alias/joined time remain null',()=>{
  const {registered_member_account_ids:_,...base}=source();
  base.members[0]!.pro_name='';base.members[0]!.time_joined=0;
  const a=verifyArchivedTeamAccounts(snapshot(base),teamId),b=verifyArchivedTeamAccounts(snapshot({...base,registered_member_account_ids:[]}),teamId);
  expect(a.registeredAccountIds).toBeNull();expect(a.members[0]).toMatchObject({registered:null,alias:null,sourceJoinedAt:null});
  expect(b.registeredAccountIds).toEqual([]);expect(b.members[0]!.registered).toBe(false);
});
it('rejects wrong team, duplicate accounts, inconsistent registered subset and unsafe source IDs',()=>{
  for(const v of [{...source(),team_id:1},{...source(),members:[source().members[0],source().members[0]]},
    {...source(),registered_member_account_ids:[101,101]},{...source(),registered_member_account_ids:[102]},
    {...source(),members:[{account_id:4294967296,pro_name:'Synthetic'}]},
    {...source(),members:[{account_id:0,pro_name:'Synthetic'}]}])expect(()=>verifyArchivedTeamAccounts(snapshot(v),teamId)).toThrow();
  expect(()=>teamAccountOriginal('https://example.invalid')).toThrow();expect(()=>teamAccountOriginal('01')).toThrow();
});
it('rejects wrong original, digest, replay clock, future join and unsupported encoding',()=>{
  const s=snapshot();for(const patch of [{originalLink:'https://example.invalid'},{digest:'A'.repeat(32)},
    {mementoDatetime:'Tue, 16 Aug 2022 12:19:31 GMT'},{fetchedAt:'2021-01-01T00:00:00.000Z'},{encoding:'br'}])
    expect(()=>verifyArchivedTeamAccounts({...s,...patch},teamId)).toThrow();
  const body=source();body.members[0]!.time_joined=1893456000;
  expect(()=>verifyArchivedTeamAccounts(snapshot(body),teamId)).toThrow('join_clock');
});
it('rejects shell/invalid UTF-8 and bounds decompression',()=>{
  expect(()=>verifyArchivedTeamAccounts(snapshot('<html>shell</html>'),teamId)).toThrow();
  const s=snapshot();for(const bytes of [gzipSync(Buffer.from([0xff])),gzipSync(Buffer.alloc(5*1024*1024))])
    expect(()=>verifyArchivedTeamAccounts({...s,bytes,digest:archiveDigest(bytes)},teamId)).toThrow();
});
it('matches exact account IDs across organizations/native sides, never aliases or old registered fives',()=>{
  const proof=verifyArchivedTeamAccounts(snapshot(),teamId),r=auditHistoricalMapAccounts([proof],map(),horizon);
  expect(r).toMatchObject({mapCount:1,observedPlayerRows:2,knownMapAccounts:2,accountsObservedBeforeCutoff:1,
    accountsWithoutMatchingArchive:1,verifiedMapLineups:0,trainingExamples:0,strictDatasetStatus:'unavailable'});
  expect(r.players[1]).toMatchObject({playerSlot:128,accountId:'101',sourceTeamIds:[teamId],canonicalPlayerId:null});
  const changed=source();changed.members[0]!.account_id=102;changed.registered_member_account_ids=[102];
  expect(auditHistoricalMapAccounts([verifyArchivedTeamAccounts(snapshot(changed),teamId)],map(),horizon).players[1]!.accountEvidenceStatus).toBe('no_matching_archive');
});
it('deduplicates repeated proofs and is independent of source member/map row order',()=>{
  const p=verifyArchivedTeamAccounts(snapshot(),teamId),m=map();
  expect(auditHistoricalMapAccounts([p,p],m,horizon)).toEqual(auditHistoricalMapAccounts([p],{...m,players:[...m.players].reverse()},horizon));
  const body=source();body.members.push({account_id:102,pro_name:'Synthetic second',time_joined:0,real_name:'private'});
  const r=verifyArchivedTeamAccounts(snapshot(body),teamId);body.members.reverse();
  expect(verifyArchivedTeamAccounts(snapshot(body),teamId).projectionSha256).toBe(r.projectionSha256);
});
it('late, equality-at-start and future-fetched proof cannot be used before map cutoff',()=>{
  const p=verifyArchivedTeamAccounts(snapshot(),teamId);
  for(const patch of [{knownByAt:map().startedAt},{knownByAt:'2024-01-01T00:00:00.000Z'},
    {fetchedAt:'2027-01-01T00:00:00.000Z'}])
    expect(auditHistoricalMapAccounts([{...p,...patch}],map(),horizon).accountsObservedBeforeCutoff).toBe(0);
  expect(()=>auditHistoricalMapAccounts([p],{...map(),fetchedAt:'2027-01-01T00:00:00.000Z'},horizon)).toThrow('clock');
});
it('unknown accounts and empty source rows do not fabricate identity or sample size',()=>{
  const r=auditHistoricalMapAccounts([],{...map(),players:[{playerSlot:0,accountId:null}]},horizon);
  expect(r).toMatchObject({mapCount:1,knownMapAccounts:0,unknownAccountRows:1,accountsObservedBeforeCutoff:0});
  expect(auditHistoricalMapAccounts([],{...map(),players:[]},horizon)).toMatchObject({observedPlayerRows:0,knownMapAccounts:0});
});
it('duplicate native slots/accounts, invalid slots, synthetic mode and wrong source endpoint are rejected',()=>{
  for(const patch of [{players:[map().players[0],map().players[0]]},
    {players:[{playerSlot:0,accountId:'101'},{playerSlot:128,accountId:'101'}]},
    {players:[{playerSlot:5,accountId:'101'}]},{mode:'synthetic'},
    {source:{...map().source,endpoint:'/matches/1'}}])
    expect(()=>auditHistoricalMapAccounts([],{...map(),...patch},horizon)).toThrow();
});
it('archive lookup has no year lower bound and uses only the fixed team-info source',async()=>{
  let called='';const c=new ArchiveEvidenceClient({raw:async url=>{called=url.href;return {status:200,headers:{},
    bytes:Buffer.from(JSON.stringify([['timestamp','original','digest'],[stamp,original,snapshot().digest]]))};}});
  expect((await c.findTeamAccountsBefore(teamId,map().startedAt)).records[0]!.capturedAt).toBe('2022-08-16T12:19:30.000Z');
  const q=new URL(called).searchParams;expect(q.has('from')).toBe(false);expect(q.get('url')).toBe(original);expect(q.get('limit')).toBe('5');
});
it('team replay retains encoded bytes and does not follow redirects',async()=>{
  const s=snapshot(),c=new ArchiveEvidenceClient({raw:async()=>({status:200,headers:{link:`<${original}>; rel="original"`,
    'memento-datetime':s.mementoDatetime,'content-encoding':'gzip'},bytes:s.bytes})});
  expect((await c.getTeamAccountsSnapshot(teamId,stamp)).bytes).toEqual(s.bytes);
  const redirect=new ArchiveEvidenceClient({raw:async()=>({status:302,headers:{location:original},bytes:Buffer.alloc(0)})});
  await expect(redirect.getTeamAccountsSnapshot(teamId,stamp)).rejects.toMatchObject({code:'archive_http_error'});
});
