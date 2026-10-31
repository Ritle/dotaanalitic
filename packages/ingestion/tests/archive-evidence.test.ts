import {expect,it} from 'vitest';
import {gzipSync} from 'node:zlib';
import {archiveDigest,parseArchiveIndex,verifyArchivedAnnouncement,archivedBodyCoverage} from '../src/valve/archive-evidence.js';
import {ArchiveEvidenceClient} from '../src/valve/archive-client.js';
import {ValvePatchClient} from '../src/valve/patch-client.js';
const id='9007199254740993',stamp='20240102120000',captured='2024-01-02T12:00:00.000Z',original=`https://store.steampowered.com/news/app/570/view/${id}`;
const epoch=(time:string)=>Date.parse(time)/1000;
function event(){return {gid:id,appid:570,clan_steamid:'103582791433224455',event_name:'Synthetic patch event',published:1,hidden:0,
  rtime32_start_time:epoch('2024-01-01T00:00:00.000Z'),rtime32_last_modified:epoch('2024-01-02T00:00:00.000Z'),build_id:0,
  announcement_body:{gid:'9007199254740994',event_gid:id,clanid:'3703047',headline:'Synthetic only',posttime:epoch('2024-01-01T00:00:00.000Z'),
    updatetime:epoch('2024-01-02T00:00:00.000Z'),body:'Synthetic announcement body & symbols " < >. Not real patch evidence.'}};}
function snapshot(events:unknown[]=[event()],gzip=true){
  const json=JSON.stringify(events).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const decoded=Buffer.from(`<div data-partnereventstore="${json}"></div>`),bytes=gzip?gzipSync(decoded):decoded;
  return {timestamp:stamp,original,digest:archiveDigest(bytes),mementoDatetime:'Tue, 02 Jan 2024 12:00:00 GMT',originalLink:original,encoding:gzip?'gzip':'identity',bytes};
}
it('archived body proves only the same body by archive time, independently of later event metadata',()=>{
  const live=event();live.rtime32_last_modified=epoch('2026-01-01T00:00:00.000Z');const r=verifyArchivedAnnouncement(snapshot(),id,live);
  expect(r).toMatchObject({status:'verified_archived_body',scope:'announcement_body_only',bodyKnownByAt:captured,currentBodyKnownByAt:captured,
    sameBodyAsCurrent:true,verifiedReleasedAt:null,heroNotesKnownAt:null,autoRegistryEligible:false});
  expect(r.archived.buildId).toBeNull();expect(r.current.eventModifiedAt).toBe('2026-01-01T00:00:00.000Z');
  expect(JSON.stringify(r)).not.toContain(live.announcement_body.body);
});
it('modified current body cannot inherit the old revision timestamp or old archive proof',()=>{
  const live=event();live.announcement_body.body+=' changed';const r=verifyArchivedAnnouncement(snapshot(),id,live);
  expect(r.bodyKnownByAt).toBe(captured);expect(r.currentBodyKnownByAt).toBeNull();expect(r.sameBodyAsCurrent).toBe(false);
});
it('CDX payload digest binds original gzip bytes rather than decoded or tampered content',()=>{
  const s=snapshot();const decoded=snapshot([event()],false);
  expect(()=>verifyArchivedAnnouncement({...s,digest:decoded.digest},id,event())).toThrow('digest_mismatch');
  expect(()=>verifyArchivedAnnouncement({...s,bytes:Buffer.from('tampered')},id,event())).toThrow('digest_mismatch');
  expect(verifyArchivedAnnouncement(decoded,id,event()).status).toBe('verified_archived_body');
});
it('wrong original link, Memento timestamp and event identity reject replay from another source/time',()=>{
  const s=snapshot();expect(()=>verifyArchivedAnnouncement({...s,originalLink:'https://secret.invalid'},id,event())).toThrow('origin_or_time');
  expect(()=>verifyArchivedAnnouncement({...s,mementoDatetime:'Wed, 03 Jan 2024 12:00:00 GMT'},id,event())).toThrow('origin_or_time');
  expect(()=>verifyArchivedAnnouncement(snapshot([{...event(),gid:'123'}]),id,event())).toThrow('identity');
  expect(()=>verifyArchivedAnnouncement(snapshot([event(),event()]),id,event())).toThrow('identity');
});
it('published/body clocks are distinct; unknown, hidden and post-archive body revisions never certify availability',()=>{
  for(const alter of [(e:ReturnType<typeof event>)=>{e.hidden=1;},(e:ReturnType<typeof event>)=>{e.published=0;},
    (e:ReturnType<typeof event>)=>{e.announcement_body.updatetime=0;},(e:ReturnType<typeof event>)=>{e.announcement_body.updatetime=epoch('2024-01-03T00:00:00.000Z');}]){
    const e=event();alter(e);expect(verifyArchivedAnnouncement(snapshot([e]),id,event()).bodyKnownByAt).toBeNull();
  }
});
it('shell-only archives and invalid app/body links fail closed, compressed output is bounded',()=>{
  const s=snapshot(),bytes=Buffer.from('<html>shell only</html>');expect(()=>verifyArchivedAnnouncement({...s,encoding:'identity',bytes,digest:archiveDigest(bytes)},id,event())).toThrow('store_missing');
  expect(()=>verifyArchivedAnnouncement(snapshot([{...event(),appid:42}]),id,event())).toThrow();
  const bomb=gzipSync(Buffer.alloc(5*1024*1024));expect(()=>verifyArchivedAnnouncement({...s,bytes:bomb,digest:archiveDigest(bomb)},id,event())).toThrow();
});
it('CDX queries are scoped to exact original and before-cutoff, unknown archive is not evidence of absence',()=>{
  expect(parseArchiveIndex([],original,captured)).toEqual([]);
  expect(()=>parseArchiveIndex([['timestamp','original','digest'],[stamp,original,snapshot().digest]],original,captured)).toThrow('index_record');
  expect(()=>parseArchiveIndex([['timestamp','original','digest'],['20240230120000',original,snapshot().digest]],original,'2025-01-01T00:00:00.000Z')).toThrow();
});
it('coverage deduplicates maps and does not turn source-text availability into patch/training eligibility',()=>{
  const proof=verifyArchivedAnnouncement(snapshot(),id,event()),row={match_id:'9007199254740995',started_at:'2024-01-03T00:00:00.000Z',flags:{confirmed_pro:true}};
  const r=archivedBodyCoverage(proof,[row,row]);expect(r).toMatchObject({observations:2,uniqueMaps:1,sourceBodyVerifiedMaps:1,verifiedPatchMaps:0,trainingExamples:0});
  expect(archivedBodyCoverage(proof,[{...row,started_at:captured}]).sourceBodyVerifiedMaps).toBe(0);
  expect(archivedBodyCoverage(proof,[row,{...row,started_at:null}]).sourceBodyVerifiedMaps).toBe(0);
});
it('official live event validates app/clan, distinct body ID and returned event ID without arbitrary endpoints',async()=>{
  let url='';const c=new ValvePatchClient({attempts:1},{fetch:async input=>{url=String(input);return Response.json({success:1,event:event()});}});
  expect((await c.getSteamEvent(id)).data.event.announcement_body.gid).not.toBe(id);expect(url).toContain('clan_accountid=3703047');
  await expect(c.getSteamEvent('https://secret.invalid')).rejects.toMatchObject({code:'invalid_event_id'});
});
it('archive transport preserves compressed bytes, honors long Retry-After and refuses redirects',async()=>{
  let count=0,now=Date.parse('2026-01-01T00:00:00.000Z');const c=new ArchiveEvidenceClient({now:()=>now,sleep:async ms=>{now+=ms;},raw:async()=>{
    count++;return {status:429,headers:{'retry-after':'30'},bytes:Buffer.alloc(0)};
  }});
  await expect(c.getSnapshot(id,stamp)).rejects.toMatchObject({code:'archive_wait_budget_exhausted',retryAfterMs:30000});expect(count).toBe(1);
  const redirect=new ArchiveEvidenceClient({raw:async()=>({status:302,headers:{location:'https://secret.invalid'},bytes:Buffer.alloc(0)})});
  await expect(redirect.getSnapshot(id,stamp)).rejects.toMatchObject({code:'archive_http_error',status:302});
  const s=snapshot(),good=new ArchiveEvidenceClient({raw:async()=>({status:200,headers:{link:`<${original}>; rel="original"`,'memento-datetime':s.mementoDatetime,'content-encoding':'gzip'},bytes:s.bytes})});
  expect((await good.getSnapshot(id,stamp)).bytes).toEqual(s.bytes);
});
