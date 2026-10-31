import {expect,it} from 'vitest';
import {gzipSync} from 'node:zlib';
import {archiveDigest} from '../src/valve/archive-evidence.js';
import {ArchiveEvidenceClient} from '../src/valve/archive-client.js';
import {verifyArchivedTi12Metadata,ti12EvidenceCoverage} from '../src/valve/tournament-evidence.js';
// Synthetic transport examples only. No database or production training examples.
const original='https://www.dota2.com/esports/ti12',stamp='20231007101410',captured='2023-10-07T10:14:10.000Z';
const event=()=>({event:21,event_name:'#dpc_event_ti12',registration_period:8,leagues:[{league_id:15728}],
  timestamp_drop_lock:1691089200,timestamp_add_lock:1691694000});
function snapshot(events:unknown[]=[event()],gzip=true,extra=''){
  const config={DOTA_APP_ID:570,BASE_URL:'https://www.dota2.com/',RENDER_TIMESTAMP:1696673650,
    DPC_DATA:JSON.stringify({events}),SESSION_ID:'synthetic-private-value',ACCOUNT_ID:123};
  const attr=JSON.stringify(config).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  const bytes=gzip?gzipSync(Buffer.from(`<div data-dota_react="${attr}"></div>${extra}`)):
    Buffer.from(`<div data-dota_react="${attr}"></div>${extra}`);
  return {timestamp:stamp,original,digest:archiveDigest(bytes),mementoDatetime:'Sat, 07 Oct 2023 10:14:10 GMT',
    originalLink:original,encoding:gzip?'gzip':'identity',bytes,fetchedAt:'2026-11-01T00:00:00.000Z'};
}
const row={match_id:'9007199254740993',started_at:'2023-10-12T17:00:44.000Z',league_id:'15728',flags:{confirmed_pro:true}};
const capture=(observations:unknown[])=>({schema_version:3,mode:'live_opendota',generated_at:'2026-10-31T12:00:00.000Z',observations});
it('binds archived metadata to exact bytes without claiming roster, patch, account or map proof',()=>{
  const result=verifyArchivedTi12Metadata(snapshot());
  expect(result).toMatchObject({status:'verified_archived_metadata',knownByAt:captured,leagueId:'15728',registrationPeriod:8,
    lineupKnownAt:null,mapSidesKnownAt:null,patchReleaseKnownAt:null,trainingReady:false,deployable:false});
  expect(result.announcedAddLockAt<result.knownByAt).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/SESSION_ID|ACCOUNT_ID|synthetic-private-value|DPC_DATA/);
  expect(verifyArchivedTi12Metadata(snapshot([event()],false)).metadataSha256).toBe(result.metadataSha256);
});
it('rejects altered payload, wrong origin, Memento time, unsupported encoding and future fetch horizon',()=>{
  const s=snapshot();
  for(const changed of [{digest:'A'.repeat(32)},{originalLink:'https://example.invalid'},
    {mementoDatetime:'Sat, 07 Oct 2023 10:14:11 GMT'},{encoding:'br'},{fetchedAt:'2023-10-01T00:00:00.000Z'}])
    expect(()=>verifyArchivedTi12Metadata({...s,...changed})).toThrow();
});
it('rejects shell-only, duplicate stores, absent/duplicate event and wrong event/league semantics',()=>{
  for(const events of [[],[event(),event()],[{...event(),league_id:15728,leagues:[]}],
    [{...event(),leagues:[{league_id:1}]}],[{...event(),registration_period:9}],[{...event(),event_name:'#another_event'}]])
    expect(()=>verifyArchivedTi12Metadata(snapshot(events))).toThrow();
  expect(()=>verifyArchivedTi12Metadata(snapshot([event()],true,'<div data-dota_react="{}"></div>'))).toThrow('ambiguous');
  const s=snapshot(),bytes=Buffer.from('<div>No embedded data</div>');
  expect(()=>verifyArchivedTi12Metadata({...s,bytes,encoding:'identity',digest:archiveDigest(bytes)})).toThrow('config_missing');
});
it('registration deadlines are source metadata, unknown/reversed/future clocks are rejected',()=>{
  for(const e of [{...event(),timestamp_add_lock:0},{...event(),timestamp_drop_lock:1691694001},
    {...event(),timestamp_add_lock:1893456000}])expect(()=>verifyArchivedTi12Metadata(snapshot([e]))).toThrow();
});
it('limits decompression and rejects invalid UTF-8',()=>{
  const s=snapshot();
  for(const bytes of [gzipSync(Buffer.alloc(5*1024*1024)),gzipSync(Buffer.from([0xff]))])
    expect(()=>verifyArchivedTi12Metadata({...s,bytes,digest:archiveDigest(bytes)})).toThrow();
});
it('counts map IDs once and never promotes metadata matches to strict eligibility',()=>{
  const result=ti12EvidenceCoverage(verifyArchivedTi12Metadata(snapshot()),capture([row,row]));
  expect(result).toMatchObject({observations:2,uniqueMaps:1,mapsWithMatchingLeagueReference:1,verifiedMapLineups:0,trainingExamples:0});
  expect(result.maps[0]).toMatchObject({matchId:row.match_id,strictTrainingEligible:false,strictContextStatus:'unavailable'});
  expect(ti12EvidenceCoverage(verifyArchivedTi12Metadata(snapshot()),capture([]))).toMatchObject({uniqueMaps:0,mapsWithMatchingLeagueReference:0});
});
it('unknown/conflicting league, start and pro fields, cutoff equality and future maps do not count',()=>{
  const proof=verifyArchivedTi12Metadata(snapshot());
  for(const other of [{...row,league_id:null},{...row,league_id:'1'},{...row,started_at:null},
    {...row,started_at:captured},{...row,flags:{confirmed_pro:null}},{...row,flags:{confirmed_pro:false}},
    {...row,started_at:'2027-01-01T00:00:00.000Z'}])
    expect(ti12EvidenceCoverage(proof,capture([other])).mapsWithMatchingLeagueReference).toBe(0);
  expect(ti12EvidenceCoverage(proof,capture([row,{...row,league_id:'1'}])).maps[0]!.sourceConflict).toBe(true);
});
it('rejects synthetic/legacy capture and report clocks after the source audit horizon',()=>{
  const proof=verifyArchivedTi12Metadata(snapshot());
  for(const patch of [{mode:'synthetic'},{schema_version:2},{generated_at:'2027-01-01T00:00:00.000Z'}])
    expect(()=>ti12EvidenceCoverage(proof,{...capture([row]),...patch})).toThrow();
});
it('TI12 client uses only fixed original, bounded October query and no result before its window',async()=>{
  let url='';const c=new ArchiveEvidenceClient({raw:async input=>{url=input.href;return {status:200,headers:{},
    bytes:Buffer.from(JSON.stringify([['timestamp','original','digest'],[stamp,original,snapshot().digest]]))};}});
  expect((await c.findTi12Before(row.started_at)).records).toHaveLength(1);
  const query=new URL(url).searchParams;expect(query.get('url')).toBe(original);expect(query.get('from')).toBe('20231001000000');
  expect(query.get('limit')).toBe('5');
  const early=new ArchiveEvidenceClient({raw:async()=>({status:200,headers:{},bytes:Buffer.from(JSON.stringify([
    ['timestamp','original','digest'],['20230901000000',original,snapshot().digest]]))})});
  await expect(early.findTi12Before(row.started_at)).rejects.toMatchObject({code:'archive_record_outside_window'});
  await expect(c.findTi12Before('2023-09-01T00:00:00.000Z')).rejects.toMatchObject({code:'invalid_archive_window'});
});
it('TI12 replay refuses redirects and requires original/Memento identity for verification',async()=>{
  const s=snapshot();const c=new ArchiveEvidenceClient({raw:async()=>({status:200,headers:{link:`<${original}>; rel="original"`,
    'memento-datetime':s.mementoDatetime,'content-encoding':'gzip'},bytes:s.bytes})});
  const r=await c.getTi12Snapshot(stamp);
  expect(verifyArchivedTi12Metadata({...r,digest:s.digest,fetchedAt:r.source.fetchedAt}).knownByAt).toBe(captured);
  const redirect=new ArchiveEvidenceClient({raw:async()=>({status:302,headers:{location:original},bytes:Buffer.alloc(0)})});
  await expect(redirect.getTi12Snapshot(stamp)).rejects.toMatchObject({code:'archive_http_error'});
});
