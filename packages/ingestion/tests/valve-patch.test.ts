import {expect,it} from 'vitest';
import {ValvePatchClient} from '../src/valve/patch-client.js';
import {comparePatchSources,assessAuditedMapPatches} from '../src/valve/patch-audit.js';
const timestamp=1700000000,label='7.99a';
const list={success:true,patches:[{patch_number:label,patch_timestamp:timestamp},{patch_number:'7.99b',patch_timestamp:timestamp+1000000}]};
const notes={success:true,patch_number:label,patch_timestamp:timestamp,heroes:[{hero_id:1,hero_notes:[{note:'Synthetic note: never real balance metadata'}],abilities:[]}]};
const news={appnews:{appid:570,newsitems:[{appid:570,gid:'9007199254740993',title:'7.99a Gameplay Patch',date:timestamp+10000,feedname:'steam_community_announcements',contents:'unused'}]}};
function client(responses:(unknown|Response|Error)[],options:ConstructorParameters<typeof ValvePatchClient>[0]={}){
  let now=1800000000000;const calls:{url:string;redirect:RequestRedirect|undefined}[]=[],sleeps:number[]=[];
  const c=new ValvePatchClient(options,{now:()=>now,sleep:async ms=>{sleeps.push(ms);now+=ms;},fetch:async(url,init)=>{
    calls.push({url:String(url),redirect:init?.redirect});const next=responses.shift();if(next instanceof Error)throw next;
    return next instanceof Response?next:Response.json(next);
  }});return {c,calls,sleeps};
}
it('official endpoints are fixed, responses validated, bigint announcement IDs preserved and knownAt unknown',async()=>{
  const {c,calls}=client([list,notes,news]);const a=await c.getPatchList(),b=await c.getPatchNotes(label),d=await c.getAnnouncements(timestamp+100000);
  expect(calls.every(x=>x.redirect==='error')).toBe(true);expect(calls[0]?.url).toMatch(/^https:\/\/www.dota2.com\//);
  expect(calls[2]?.url).toMatch(/^https:\/\/api.steampowered.com\//);expect(d.data.appnews.newsitems[0]?.gid).toBe('9007199254740993');
  expect(a.source.knownAt).toBeNull();expect(b.source.payloadSha256).toMatch(/^[a-f0-9]{64}$/);expect(c.requestStats.attempts).toBe(3);
  expect(await c.getPatchNotes('https://secret.invalid').catch(e=>e.code)).toBe('invalid_patch_label');
});
it('429 retry respects Retry-After, serial pacing and bounded attempts',async()=>{
  const {c,calls,sleeps}=client([new Response('',{status:429,headers:{'retry-after':'2'}}),list]);
  expect((await c.getPatchList()).source.attempts).toBe(2);expect(calls).toHaveLength(2);expect(sleeps).toContain(2000);
  expect(c.requestStats.httpStatuses).toEqual({'429':1,'200':1});
});
it('long Retry-After keeps the next request blocked and quota cannot be bypassed by another method',async()=>{
  const {c,calls}=client([new Response('',{status:429,headers:{'retry-after':'30'}}),list],{maxWaitMs:1000});
  await expect(c.getPatchList()).rejects.toMatchObject({code:'source_rate_limited',retryAfterMs:30000});
  await expect(c.getPatchNotes(label)).rejects.toMatchObject({code:'source_wait_budget_exhausted'});expect(calls).toHaveLength(1);
  const one=client([list,list],{maxRequests:1});await one.c.getPatchList();await expect(one.c.getPatchList()).rejects.toMatchObject({code:'request_budget_exhausted'});
});
it('network/5xx retry stays bounded and error text cannot leak into observable error',async()=>{
  const {c}=client([new Error('credential-secret'),new Response('',{status:503})]);
  await expect(c.getPatchList()).rejects.toMatchObject({code:'source_http_error',status:503});
  const denied=client([new Response('',{status:403}),list]);await expect(denied.c.getPatchList()).rejects.toMatchObject({status:403});expect(denied.calls).toHaveLength(1);
  const broken=client([new Error('credential-secret')],{attempts:1});await expect(broken.c.getPatchList()).rejects.not.toThrow('credential-secret');
});
it('invalid JSON, schema, duplicate labels/heroes, wrong patch and oversize data fail closed',async()=>{
  await expect(client([new Response('<html>secret</html>')]).c.getPatchList()).rejects.toMatchObject({code:'source_invalid_json'});
  await expect(client([{...list,success:false}]).c.getPatchList()).rejects.toMatchObject({code:'source_schema_invalid'});
  await expect(client([{...list,patches:[list.patches[0],list.patches[0]]}]).c.getPatchList()).rejects.toMatchObject({code:'source_schema_invalid'});
  await expect(client([{...notes,patch_number:'7.99b'}]).c.getPatchNotes(label)).rejects.toMatchObject({code:'source_id_mismatch'});
  await expect(client([{...notes,heroes:[notes.heroes[0],notes.heroes[0]]}]).c.getPatchNotes(label)).rejects.toMatchObject({code:'duplicate_hero_notes'});
  await expect(client([list],{maxBytes:10}).c.getPatchList()).rejects.toMatchObject({code:'source_response_too_large'});
});
it('timeouts cancel transport and expose a stable code',async()=>{
  const c=new ValvePatchClient({timeoutMs:5,attempts:1},{fetch:async(_url,init)=>new Promise((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('secret timeout'))))});
  await expect(c.getPatchList()).rejects.toMatchObject({code:'source_timeout'});
});
async function observations(l:unknown=list,n:unknown=notes,a:unknown=news){const {c}=client([l,n,a]);return [await c.getPatchList(),await c.getPatchNotes(label),await c.getAnnouncements(timestamp+100000)] as const;}
it('disagreeing primary timestamps remain facts under review, never a guessed effective release',async()=>{
  const [l,n,a]=await observations(),r=comparePatchSources(label,l,n,a);
  expect(r.timestampSpreadSeconds).toBe(10000);expect(r.reasons).toContain('FEED_ANNOUNCEMENT_TIMESTAMP_DISAGREEMENT');
  expect(r).toMatchObject({verifiedReleasedAt:null,coverageUntil:null,knownAt:null,autoRegistryEligible:false});
  expect(r.heroNotes[0]).toMatchObject({heroId:1,impactLevel:null,availability:null});expect(JSON.stringify(r)).not.toContain('Synthetic note');
});
it('matching times or missing hero rows do not prove deployment, unchanged impact or Captains Mode eligibility',async()=>{
  const equal={appnews:{...news.appnews,newsitems:news.appnews.newsitems.map(n=>({...n,date:timestamp}))}};
  const [l,n,a]=await observations(list,{...notes,heroes:[]},equal),r=comparePatchSources(label,l,n,a);
  expect(r.timestampSpreadSeconds).toBe(0);expect(r.heroNotes).toEqual([]);expect(r.verifiedReleasedAt).toBeNull();expect(r.autoRegistryEligible).toBe(false);
});
it('omitted note blocks remain unknown while explicitly empty blocks have observed zero entries',async()=>{
  const [l,n,a]=await observations(list,{...notes,heroes:[{hero_id:1},{hero_id:2,hero_notes:[],abilities:[]}]});
  const r=comparePatchSources(label,l,n,a);expect(r.heroNotes[0]).toMatchObject({directNotes:null,abilityNotes:null});
  expect(r.heroNotes[1]).toMatchObject({directNotes:0,abilityNotes:0});
});
it('only app-specific official announcement feed and exact patch token are considered; missing page is unknown',async()=>{
  const wrong={appnews:{...news.appnews,newsitems:[{...news.appnews.newsitems[0],title:'7.99ab Gameplay Patch'},{...news.appnews.newsitems[0],feedname:'untrusted'}]}};
  const [l,n,a]=await observations(list,notes,wrong),r=comparePatchSources(label,l,n,a);
  expect(r.announcementCandidates).toEqual([]);expect(r.firstAnnouncementDeltaSeconds).toBeNull();expect(r.reasons).toContain('ANNOUNCEMENT_NOT_FOUND_IN_BOUNDED_PAGE');
});
it('same map across captures counts once and nominal intervals cannot certify true patch or as-of availability',async()=>{
  const [l]=await observations(),capture={schema_version:3,mode:'live_opendota',observations:[{match_id:'9007199254740993',started_at:new Date((timestamp+50000)*1000).toISOString(),flags:{confirmed_pro:true}}]};
  const r=assessAuditedMapPatches([capture,capture],l);expect(r).toMatchObject({observations:2,uniqueMaps:1,duplicateObservations:1,verifiedPatchMaps:0,historicalAvailabilityAssessed:false});
  expect(r.maps[0]).toMatchObject({nominalPatchCandidate:label,verifiedPatchId:null,historicalKnownAt:null});
  const late=structuredClone(capture);late.observations[0]!.started_at=new Date((timestamp+2000000)*1000).toISOString();
  expect(assessAuditedMapPatches([late],l).maps[0]?.nominalPatchCandidate).toBeNull();
  expect(assessAuditedMapPatches([capture,late],l).maps[0]?.reasons).toContain('CAPTURE_CONFLICT_OR_UNVERIFIED_PRO');
});
