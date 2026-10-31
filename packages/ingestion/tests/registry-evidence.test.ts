import {it,expect} from 'vitest';
import {gzipSync} from 'node:zlib';
import {archiveDigest} from '../src/valve/archive-evidence.js';
import {steam64FromAccount} from '../src/valve/steam-profile-evidence.js';
import {ArchiveEvidenceClient} from '../src/valve/archive-client.js';
import {PRO_REGISTRY_ORIGINAL,verifyArchivedProRegistry,parseProRegistryArchiveIndex,assessRegistryIdentityEvidence} from '../src/opendota/registry-evidence.js';
const targets=['101','102'],stamp='20230411210628',horizon='2026-11-01T00:00:00.000Z';
// Synthetic provider rows and reviewed claims only; no production identity records are created.
const row=(id=101)=>({account_id:id,steamid:steam64FromAccount(String(id)),name:'Synthetic registered alias',team_id:42,
  is_pro:true,is_locked:true,personaname:'private display',last_login:'private',fantasy_role:3});
function snap(data:unknown=[row(),row(102)],gzip=true){const raw=Buffer.from(JSON.stringify(data)),bytes=gzip?gzipSync(raw):raw;
  return {bytes,encoding:gzip?'gzip':'identity',digest:archiveDigest(bytes),timestamp:stamp,original:PRO_REGISTRY_ORIGINAL+'?',
    originalLink:PRO_REGISTRY_ORIGINAL+'?',mementoDatetime:'Tue, 11 Apr 2023 21:06:28 GMT',fetchedAt:'2026-10-31T00:00:00.000Z'};}
const map=()=>({schemaVersion:1,mode:'live_opendota_map_account_observation',matchId:'999999999999999',leagueId:'15728',
  startedAt:'2023-10-12T17:00:44.000Z',fetchedAt:'2026-10-31T00:00:00.000Z',knownAt:null,
  source:{endpoint:'/matches/999999999999999',payloadSha256:'a'.repeat(64),adapterVersion:'synthetic-test'},
  players:[{playerSlot:128,accountId:'101'},{playerSlot:0,accountId:'102'}]});
const ledger=()=>({schemaVersion:1,mode:'read_only_identity_ledger_snapshot',observedAt:'2026-10-31T12:00:00.000Z',
  registryRevision:'1',accountIds:targets,observations:[] as ReturnType<typeof claim>[],referencesRedactedToSha256:true});
function claim(id='101',playerId='9007199254740993',status='verified',observationId='proof:1'){
  return {observationId,claim:{playerId,provider:'opendota',externalAccountId:id,status,eventAt:null,
    knownAt:'2023-01-01T00:00:00.000Z',fetchedAt:'2026-10-31T00:00:00.000Z',source:'sha256:synthetic-source',evidenceRef:'sha256:synthetic-evidence'}};
}
const proof=()=>verifyArchivedProRegistry(snap(),targets);
it('projects requested source accounts only, preserving pro/locked as provider assertions',()=>{
  const p=verifyArchivedProRegistry(snap([row(),row(102),row(103)]),targets);
  expect(p).toMatchObject({sourceRowCount:3,requestedAccountIds:targets,missingAccountIds:[],autoIdentityMergeEligible:false,trainingExamples:0});
  expect(p.members).toHaveLength(2);expect(p.members[0]).toMatchObject({reportedPro:true,reportedLocked:true,reportedTeamId:'42'});
  expect(JSON.stringify(p)).not.toMatch(/private|last_login|personaname|fantasy_role/);
  expect(verifyArchivedProRegistry(snap([row(102),row()],false),[...targets].reverse()).projectionSha256).toBe(proof().projectionSha256);
});
it('unknown fields and zero team sentinel stay null; missing accounts are not invented',()=>{
  const p=verifyArchivedProRegistry(snap([{account_id:101,team_id:0,name:''}]),targets);
  expect(p.members[0]).toEqual({accountId:'101',steam64:null,alias:null,reportedTeamId:null,reportedPro:null,reportedLocked:null});
  expect(p.missingAccountIds).toEqual(['102']);expect(verifyArchivedProRegistry(snap([]),targets).members).toEqual([]);
});
it('rejects duplicate/invalid source IDs, target duplicates and conflicting Steam64',()=>{
  for(const data of [[row(),row()],[row(),{account_id:0}],[{...row(),account_id:4294967296}],
    [{...row(),steamid:steam64FromAccount('102')}],[{...row(),steamid:Number(steam64FromAccount('101'))}],[{...row(),is_pro:'true'}]])
    expect(()=>verifyArchivedProRegistry(snap(data),targets)).toThrow();
  expect(()=>verifyArchivedProRegistry(snap(),['101','101'])).toThrow();expect(()=>verifyArchivedProRegistry(snap(),[])).toThrow();
});
it('rejects wrong origin/digest/Memento/future fetch and unsupported compression',()=>{
  for(const patch of [{original:PRO_REGISTRY_ORIGINAL+'?api_key=secret'},{originalLink:PRO_REGISTRY_ORIGINAL},
    {digest:'A'.repeat(32)},{mementoDatetime:'Tue, 11 Apr 2023 21:06:29 GMT'},
    {fetchedAt:'2022-01-01T00:00:00.000Z'},{encoding:'br'}])expect(()=>verifyArchivedProRegistry({...snap(),...patch},targets)).toThrow();
});
it('bounds decompression and rejects invalid UTF-8 or non-array responses',()=>{
  for(const bytes of [gzipSync(Buffer.from([0xff])),gzipSync(Buffer.alloc(5*1024*1024))])
    expect(()=>verifyArchivedProRegistry({...snap(),bytes,digest:archiveDigest(bytes)},targets)).toThrow();
  expect(()=>verifyArchivedProRegistry(snap({error:'synthetic'}),targets)).toThrow();
});
it('index accepts only the fixed registry URL and its empty query, with strict cutoff',()=>{
  const header=['timestamp','original','digest'];
  expect(parseProRegistryArchiveIndex([header,[stamp,PRO_REGISTRY_ORIGINAL+'?',snap().digest]],PRO_REGISTRY_ORIGINAL,map().startedAt)).toHaveLength(1);
  for(const record of [[stamp,PRO_REGISTRY_ORIGINAL+'?x=1',snap().digest],['20231012170044',PRO_REGISTRY_ORIGINAL,snap().digest]])
    expect(()=>parseProRegistryArchiveIndex([header,record],PRO_REGISTRY_ORIGINAL,map().startedAt)).toThrow();
});
it('complete registry coverage does not manufacture verified canonical links from aliases or flags',()=>{
  const r=assessRegistryIdentityEvidence(proof(),map(),ledger(),horizon);
  expect(r).toMatchObject({mapCount:1,registryObservedAccounts:2,registryReportedProAccounts:2,canonicalVerifiedAccounts:0,
    accountsRequiringLinkReview:2,verifiedMapLineups:0,trainingExamples:0,strictDatasetStatus:'unavailable'});
  expect(r.players.every(p=>p.canonicalPlayerId===null&&p.canonicalStatus==='unknown')).toBe(true);
});
it('accepts the empty ledger revision zero, but rejects negative or out-of-range revisions',()=>{
  expect(assessRegistryIdentityEvidence(proof(),map(),{...ledger(),registryRevision:'0'},horizon).ledgerRevision).toBe('0');
  for(const registryRevision of ['-1','01','9223372036854775808'])
    expect(()=>assessRegistryIdentityEvidence(proof(),map(),{...ledger(),registryRevision},horizon)).toThrow();
});
it('uses only existing verified as-of claims; provisional, legacy and late-known claims remain unresolved',()=>{
  const l=ledger();l.observations=[claim()];
  expect(assessRegistryIdentityEvidence(proof(),map(),l,horizon).canonicalVerifiedAccounts).toBe(1);
  for(const patch of [{status:'provisional'},{knownAt:null},{knownAt:'2024-01-01T00:00:00.000Z'},
    {eventAt:'2024-01-01T00:00:00.000Z'}]){
    const record=claim();Object.assign(record.claim,patch);l.observations=[record];
    expect(assessRegistryIdentityEvidence(proof(),map(),l,horizon).canonicalVerifiedAccounts).toBe(0);
  }
});
it('preserves contradictory verified/rejected claims rather than selecting the last source',()=>{
  const l=ledger();l.observations=[claim(),claim('101','9007199254740994','verified','proof:2')];
  expect(assessRegistryIdentityEvidence(proof(),map(),l,horizon)).toMatchObject({canonicalVerifiedAccounts:0,canonicalConflictingAccounts:1});
  l.observations=[claim(),claim('101','9007199254740993','rejected','proof:2')];
  expect(assessRegistryIdentityEvidence(proof(),map(),l,horizon).canonicalConflictingAccounts).toBe(1);
});
it('duplicate canonical player across map accounts invalidates both accounts for lineup use',()=>{
  const l=ledger();l.observations=[claim(),claim('102','9007199254740993','verified','proof:2')];
  expect(assessRegistryIdentityEvidence(proof(),map(),l,horizon)).toMatchObject({canonicalVerifiedAccounts:0,
    duplicateCanonicalAccounts:2,accountsRequiringLinkReview:2,verifiedMapLineups:0});
});
it('source equality at cutoff is unavailable, and future ledger/proof clocks are rejected',()=>{
  expect(assessRegistryIdentityEvidence({...proof(),knownByAt:map().startedAt},map(),ledger(),horizon).registryObservedAccounts).toBe(0);
  expect(()=>assessRegistryIdentityEvidence({...proof(),fetchedAt:'2027-01-01T00:00:00.000Z'},map(),ledger(),horizon)).toThrow();
  expect(()=>assessRegistryIdentityEvidence(proof(),map(),{...ledger(),observedAt:'2027-01-01T00:00:00.000Z'},horizon)).toThrow();
});
it('rejects tampered projection, wrong ledger scope, duplicate observations and claims fetched after ledger snapshot',()=>{
  expect(()=>assessRegistryIdentityEvidence({...proof(),projectionSha256:'a'.repeat(64)},map(),ledger(),horizon)).toThrow();
  expect(()=>assessRegistryIdentityEvidence(proof(),map(),{...ledger(),accountIds:['101']},horizon)).toThrow();
  const l=ledger();l.observations=[claim(),claim()];expect(()=>assessRegistryIdentityEvidence(proof(),map(),l,horizon)).toThrow();
  l.observations=[claim('103')];expect(()=>assessRegistryIdentityEvidence(proof(),map(),l,horizon)).toThrow();
  l.observations=[claim()];l.observations[0]!.claim.fetchedAt=horizon;expect(()=>assessRegistryIdentityEvidence(proof(),map(),l,horizon)).toThrow();
});
it('native slot/source/ledger order does not change the review fingerprint',()=>{
  const l=ledger();l.observations=[claim(),claim('102','2','verified','proof:2')];
  expect(assessRegistryIdentityEvidence(proof(),map(),l,horizon)).toEqual(assessRegistryIdentityEvidence(proof(),
    {...map(),players:[...map().players].reverse()},{...l,accountIds:[...l.accountIds].reverse(),observations:[...l.observations].reverse()},horizon));
});
it('archive client uses the fixed 2023 window and refuses foreign snapshot URLs before requests',async()=>{
  let url='';const c=new ArchiveEvidenceClient({raw:async u=>{url=u.href;return {status:200,headers:{},bytes:Buffer.from('[]')};}});
  await c.findProRegistryBefore(map().startedAt);const q=new URL(url).searchParams;
  expect(q.get('from')).toBe('20230101000000');expect(q.get('url')).toBe(PRO_REGISTRY_ORIGINAL);expect(q.get('limit')).toBe('5');
  await expect(c.getProRegistrySnapshot('https://example.invalid',stamp)).rejects.toThrow();expect(c.requestStats.attempts).toBe(1);
});
