import {it,expect} from 'vitest';
import {gzipSync} from 'node:zlib';
import {archiveDigest} from '../src/valve/archive-evidence.js';
import {ArchiveEvidenceClient} from '../src/valve/archive-client.js';
import {teamAccountOriginal,verifyArchivedTeamAccounts} from '../src/valve/team-account-evidence.js';
import {steam64FromAccount,steamProfileOriginal,steamProfileLocation,parseSteamProfileArchiveIndex,
  verifyArchivedSteamProfile,auditHistoricalAccountSources} from '../src/valve/steam-profile-evidence.js';
const id='101',original=steamProfileOriginal(id),stamp='20220101120000',horizon='2026-11-01T00:00:00.000Z';
// Explicit synthetic data; private fields must never reach a saved projection.
const data=()=>({steamid:steam64FromAccount(id),url:original,personaname:'Synthetic alias',summary:'private detail { "; }'});
const html=(p:unknown=data())=>`<html><script>var g_rgProfileData = ${JSON.stringify(p)}; untrustedCode();</script><script>var g_sessionID = "synthetic-private";</script></html>`;
function snap(text=html(),compress=true){const bytes=compress?gzipSync(text):Buffer.from(text);return {timestamp:stamp,original,originalLink:original,
  digest:archiveDigest(bytes),mementoDatetime:'Sat, 01 Jan 2022 12:00:00 GMT',encoding:compress?'gzip':'identity',bytes,fetchedAt:'2026-10-31T00:00:00.000Z'};}
const map=()=>({schemaVersion:1,mode:'live_opendota_map_account_observation',matchId:'999999999999999',leagueId:'15728',
  startedAt:'2023-10-12T17:00:44.000Z',fetchedAt:'2026-10-31T00:00:00.000Z',knownAt:null,
  source:{endpoint:'/matches/999999999999999',payloadSha256:'a'.repeat(64),adapterVersion:'synthetic-test'},
  players:[{playerSlot:128,accountId:'101'},{playerSlot:0,accountId:'102'}]});
it('maps public individual account IDs with bigint precision and rejects other input ranges',()=>{
  expect(steam64FromAccount('1')).toBe('76561197960265729');expect(steam64FromAccount('4294967295')).toBe('76561202255233023');
  for(const value of ['0','01','4294967296','76561197960265729','-1'])expect(()=>steam64FromAccount(value)).toThrow();
});
it('allows only reviewed protocol/default-port/trailing-slash variants for the same profile',()=>{
  for(const url of [original,original.slice(0,-1),original.replace('https:','http:').replace('.com/','.com:80/')])
    expect(steamProfileLocation(url,id)).toBe(`profiles/${steam64FromAccount(id)}`);
  for(const url of [original+'?xml=1',original+'#fragment',original.replace('.com/','.com:444/'),original.replace('.com','.com.evil'),
    original.replace('steamcommunity','user@steamcommunity'),original.replace('/profiles/','/id/../profiles/'),steamProfileOriginal('102')])
    expect(()=>steamProfileLocation(url,id)).toThrow();
});
it('binds archived JSON profile ID without retaining private fields or asserting a person/team',()=>{
  const p=verifyArchivedSteamProfile(snap(),id);
  expect(p).toMatchObject({accountId:id,alias:'Synthetic alias',knownByAt:'2022-01-01T12:00:00.000Z',
    verifiedPersonIdentity:false,teamId:null,proStatus:null,canonicalPlayerId:null,trainingExamples:0,deployable:false});
  expect(JSON.stringify(p)).not.toMatch(/private|summary|sessionID|untrustedCode/);
  expect(verifyArchivedSteamProfile(snap(html(),false),id).projectionSha256).toBe(p.projectionSha256);
});
it('vanity URL is only a locator: the embedded numeric account must match',()=>{
  const url='https://steamcommunity.com/id/synthetic-player/';
  const s=snap(html({...data(),url}));s.original=url;s.originalLink=url;
  expect(verifyArchivedSteamProfile(s,id).accountId).toBe(id);
  const wrong=snap(html({...data(),url,steamid:steam64FromAccount('102')}));wrong.original=url;wrong.originalLink=url;
  expect(()=>verifyArchivedSteamProfile(wrong,id)).toThrow('identity_mismatch');
});
it('empty/null alias stays unknown and no nickname matching is needed',()=>{
  for(const personaname of ['',null,'   '])expect(verifyArchivedSteamProfile(snap(html({...data(),personaname})),id).alias).toBeNull();
});
it('rejects missing/duplicate profile assignments and JSON keys',()=>{
  for(const text of ['<html>empty shell</html>',html()+html(),html().replace('"steamid":','"steamid":"0","steamid":'),
    '<script>/* var g_rgProfileData = {}; */</script>',html().replace('var g_rgProfileData =','var g_rgProfileData = run(')])
    expect(()=>verifyArchivedSteamProfile(snap(text),id)).toThrow();
});
it('rejects executable assignment expressions and parses multiline JSON without evaluating JS',()=>{
  expect(verifyArchivedSteamProfile(snap(`<script>\nvar g_rgProfileData = ${JSON.stringify(data(),null,2)};</script>`),id).accountId).toBe(id);
  expect(()=>verifyArchivedSteamProfile(snap(html().replace('; untrustedCode()',' + run(); untrustedCode()')),id)).toThrow();
});
it('rejects a later conflicting assignment in the same script and ignored inline data in an external script tag',()=>{
  const second=JSON.stringify({...data(),steamid:steam64FromAccount('102')});
  for(const text of [html().replace('untrustedCode();',`g_rgProfileData = ${second};`),
    html().replace('<script>var g_rgProfileData','<script src="https://example.invalid/code.js">var g_rgProfileData')])
    expect(()=>verifyArchivedSteamProfile(snap(text),id)).toThrow();
});
it('rejects mismatched origin, digest, Memento and future capture clocks',()=>{
  for(const patch of [{originalLink:original+'x'},{digest:'A'.repeat(32)},{mementoDatetime:'Sat, 01 Jan 2022 12:00:01 GMT'},
    {fetchedAt:'2021-01-01T00:00:00.000Z'},{encoding:'br'}])expect(()=>verifyArchivedSteamProfile({...snap(),...patch},id)).toThrow();
  expect(()=>verifyArchivedSteamProfile(snap(html({...data(),url:steamProfileOriginal('102')})),id)).toThrow();
});
it('bounds decompression and rejects invalid UTF-8',()=>{
  for(const bytes of [gzipSync(Buffer.alloc(5*1024*1024)),gzipSync(Buffer.from([0xff]))])
    expect(()=>verifyArchivedSteamProfile({...snap(),bytes,digest:archiveDigest(bytes)},id)).toThrow();
});
it('index variants keep exact profile identity and strict cutoff',()=>{
  const row=[stamp,original.replace('https:','http:').slice(0,-1),snap().digest],header=['timestamp','original','digest'];
  expect(parseSteamProfileArchiveIndex([header,row],original,id,map().startedAt)).toHaveLength(1);
  expect(parseSteamProfileArchiveIndex([],original,id,map().startedAt)).toEqual([]);
  for(const patch of [[stamp,steamProfileOriginal('102'),snap().digest],['20231012170044',original,snap().digest],
    [stamp,'https://steamcommunity.com/id/synthetic-other/',snap().digest]])
    expect(()=>parseSteamProfileArchiveIndex([header,patch],original,id,map().startedAt)).toThrow();
});
it('combined source coverage counts maps/accounts once and never promotes profiles to organization or identity evidence',()=>{
  const p=verifyArchivedSteamProfile(snap(),id),a=auditHistoricalAccountSources([],[p],map(),horizon);
  expect(a).toMatchObject({mapCount:1,knownMapAccounts:2,organizationObservedAccounts:0,profileOnlyAccounts:1,
    accountsObservedBeforeCutoff:1,accountsWithoutMatchingArchive:1,verifiedMapLineups:0,trainingExamples:0});
  expect(auditHistoricalAccountSources([],[p,p],{...map(),players:[...map().players].reverse()},horizon)).toEqual(a);
  const bytes=Buffer.from(JSON.stringify({team_id:42,members:[{account_id:101,pro_name:'Different synthetic alias'}]}));
  const team=verifyArchivedTeamAccounts({...snap(),bytes,encoding:'identity',digest:archiveDigest(bytes),
    original:teamAccountOriginal('42'),originalLink:teamAccountOriginal('42')},'42');
  expect(auditHistoricalAccountSources([team],[p],map(),horizon)).toMatchObject({organizationObservedAccounts:1,
    profileObservedAccounts:1,profileOnlyAccounts:0,accountsObservedBeforeCutoff:1});
});
it('late/equal cutoff and future-fetched profiles cannot contribute to historical coverage',()=>{
  const p=verifyArchivedSteamProfile(snap(),id);
  for(const patch of [{knownByAt:map().startedAt},{knownByAt:'2024-01-01T00:00:00.000Z'},{fetchedAt:'2027-01-01T00:00:00.000Z'}])
    expect(auditHistoricalAccountSources([],[{...p,...patch}],map(),horizon).accountsObservedBeforeCutoff).toBe(0);
  expect(()=>auditHistoricalAccountSources([],[{...p,steam64:steam64FromAccount('102')}],map(),horizon)).toThrow();
});
it('unknown rows and zero samples remain explicit',()=>{
  expect(auditHistoricalAccountSources([],[],{...map(),players:[{playerSlot:0,accountId:null}]},horizon))
    .toMatchObject({unknownAccountRows:1,knownMapAccounts:0,accountsObservedBeforeCutoff:0});
  expect(auditHistoricalAccountSources([],[],{...map(),players:[]},horizon).players).toEqual([]);
});
it('transport supports exact indexed profile forms with bounded configurable attempts',async()=>{
  let calls=0;const raw=async()=>{calls++;return {status:200,headers:{},bytes:Buffer.from('[]')};};
  const c=new ArchiveEvidenceClient({raw,now:()=>0,sleep:async()=>{},maxRequests:8});
  for(let i=0;i<8;i++)await c.findSteamProfileBefore(id,original,map().startedAt);
  await expect(c.findSteamProfileBefore(id,original,map().startedAt)).rejects.toMatchObject({code:'archive_request_budget_exhausted'});
  expect(calls).toBe(8);expect(()=>new ArchiveEvidenceClient({maxRequests:9})).toThrow();
  await expect(c.getSteamProfileSnapshot(id,'https://example.invalid/',stamp)).rejects.toThrow();expect(calls).toBe(8);
});
