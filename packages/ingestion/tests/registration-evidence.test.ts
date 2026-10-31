import {expect,it} from 'vitest';
import {gzipSync} from 'node:zlib';
import {archiveDigest} from '../src/valve/archive-evidence.js';
import {verifyArchivedTeamRegistration} from '../src/valve/registration-evidence.js';
const teamId='9007199254740993',original=`https://www.dota2.com/majorsregistration/teammembers?team_id=${teamId}`;
// Synthetic names only. Never matched to accounts or canonical players.
const rows=()=>Array.from({length:5},(_,i)=>({nickname:`synthetic-${i}`,full_name:'private-field-to-discard',confirmation_time:1693500000}));
function snapshot(value:unknown=rows(),gzip=true){
  const decoded=Buffer.from(JSON.stringify(value)),bytes=gzip?gzipSync(decoded):decoded;
  return {original,originalLink:original,timestamp:'20231001083937',mementoDatetime:'Sun, 01 Oct 2023 08:39:37 GMT',
    digest:archiveDigest(bytes),encoding:gzip?'gzip':'identity',bytes,fetchedAt:'2026-11-01T00:00:00.000Z'};
}
it('proves the published nickname rows by archive time without identity, map, side or roles',()=>{
  const r=verifyArchivedTeamRegistration(snapshot(),teamId);
  expect(r).toMatchObject({registeredRows:5,distinctNicknames:5,knownByAt:'2023-10-01T08:39:37.000Z',verifiedCanonicalPlayers:0,
    verifiedMapLineups:0,mapId:null,mapSide:null,roles:null,autoIdentityMergeEligible:false,trainingReady:false});
  expect(r.entries.every(e=>e.canonicalPlayerId===null&&e.externalAccountId===null)).toBe(true);
  expect(JSON.stringify(r)).not.toMatch(/full_name|private-field/);
  expect(verifyArchivedTeamRegistration(snapshot(rows(),false),teamId).projectionSha256).toBe(r.projectionSha256);
});
it('same nicknames do not resolve identity and repeated rows do not manufacture distinct players',()=>{
  const r=verifyArchivedTeamRegistration(snapshot([rows()[0],rows()[0]]),teamId);
  expect(r).toMatchObject({registeredRows:2,distinctNicknames:1,verifiedCanonicalPlayers:0,verifiedMapLineups:0});
});
it('empty and unknown confirmation dates remain explicit and never inherit a registration date as known-at',()=>{
  expect(verifyArchivedTeamRegistration(snapshot([]),teamId)).toMatchObject({registeredRows:0,verifiedMapLineups:0});
  const r=verifyArchivedTeamRegistration(snapshot([{nickname:'synthetic',confirmation_time:null}]),teamId);
  expect(r.entries[0]!.sourceConfirmationAt).toBeNull();expect(r.sourceConfirmationIsKnownAt).toBe(false);
});
it('rejects wrong team source, changed digest, Memento clock and future source/fetch time',()=>{
  const s=snapshot();
  expect(()=>verifyArchivedTeamRegistration(s,'1')).toThrow('origin');
  for(const change of [{digest:'A'.repeat(32)},{fetchedAt:'2023-01-01T00:00:00.000Z'},
    {mementoDatetime:'Sun, 01 Oct 2023 08:39:38 GMT'}])expect(()=>verifyArchivedTeamRegistration({...s,...change},teamId)).toThrow();
  expect(()=>verifyArchivedTeamRegistration(snapshot([{nickname:'synthetic',confirmation_time:1893456000}]),teamId)).toThrow('clock');
});
it('rejects shell or invalid structured records rather than extracting names from HTML',()=>{
  for(const input of ['<html>names</html>',[{nickname:'',confirmation_time:null}],[{nickname:'x',confirmation_time:'2023'}]])
    expect(()=>verifyArchivedTeamRegistration(snapshot(input),teamId)).toThrow();
  expect(()=>verifyArchivedTeamRegistration(snapshot(),'https://example.invalid')).toThrow();
});
it('bounds compressed bytes and encoding and rejects invalid UTF-8',()=>{
  const s=snapshot();expect(()=>verifyArchivedTeamRegistration({...s,encoding:'br'},teamId)).toThrow();
  for(const bytes of [gzipSync(Buffer.alloc(5*1024*1024)),gzipSync(Buffer.from([0xff]))])
    expect(()=>verifyArchivedTeamRegistration({...s,bytes,digest:archiveDigest(bytes)},teamId)).toThrow();
});
