import {test,expect} from 'vitest';
import {OpenDotaTeamDirectoryClient} from '../src/opendota/team-directory';
import {catalogueDirectoryCandidates,catalogueTeamCandidate} from '../src/roster-catalogue';
import {createHash} from 'node:crypto';
const rows=[{team_id:10322861,name:'Angry Birds',tag:'AB'},{team_id:'9007199254740993',name:'Synthetic BIGINT',tag:null}];
const budget=()=>({beforeRequest:async()=>{},observe:async()=>{}});
test('directory validates numeric IDs without requiring any registered player membership',async()=>{
 const r=await new OpenDotaTeamDirectoryClient(budget(),{},async()=>Response.json(rows)).read();
 expect(r.data.map(t=>t.team_id)).toEqual(['10322861','9007199254740993']);expect(r.source.endpoint).toBe('/teams');
 expect(catalogueDirectoryCandidates(r,'angry birds')[0]!.id).toBe('10322861');expect(catalogueDirectoryCandidates(r,'AB')).toHaveLength(1);
 expect(catalogueDirectoryCandidates(r,'9007199254740993')[0]!.id).toBe('9007199254740993');
});
test('separate numeric team profile must match its requested endpoint and raw hash',async()=>{
 const rawBody=JSON.stringify(rows[0]),observation={rawBody,source:{endpoint:'/teams/10322861',fetchedAt:new Date().toISOString(),payloadSha256:createHash('sha256').update(rawBody).digest('hex')}};
 expect(catalogueTeamCandidate(observation,'10322861')!.name).toBe('Angry Birds');
 expect(()=>catalogueTeamCandidate(observation,'71')).toThrow();expect(()=>catalogueTeamCandidate({...observation,rawBody:'{}'},'10322861')).toThrow();
});
test('duplicate or unsafe numeric team IDs and invalid payloads are rejected',async()=>{
 for(const value of [[rows[0],rows[0]],[{team_id:9007199254740992,name:'Unsafe'}],{teams:rows}]){
  await expect(new OpenDotaTeamDirectoryClient(budget(),{},async()=>Response.json(value)).read()).rejects.toMatchObject({code:'source_schema_invalid'});
 }
});
test('429 Retry-After bounds retries and returns safe error metadata',async()=>{
 let calls=0;await expect(new OpenDotaTeamDirectoryClient(budget(),{},async()=>{calls++;return new Response('private provider error',{status:429,headers:{'Retry-After':'30'}});}).read()).rejects.toMatchObject({code:'source_rate_limited',retryAfterMs:30000});expect(calls).toBe(1);
});
test('a transient 5xx is retried once under the same quota boundary',async()=>{
 let calls=0,reservations=0;const b={...budget(),beforeRequest:async()=>{reservations++;}};
 const r=await new OpenDotaTeamDirectoryClient(b,{},async()=>++calls===1?new Response('',{status:503}):Response.json(rows),async()=>{}).read();expect(calls).toBe(2);expect(reservations).toBe(2);expect(r.source.attempts).toBe(2);
});
test('quota rejection makes no HTTP request, credentials are not reflected in errors',async()=>{
 let calls=0;await expect(new OpenDotaTeamDirectoryClient({...budget(),beforeRequest:async()=>{throw Error('quota');}},{},async()=>{calls++;return Response.json(rows);}).read()).rejects.toThrow('quota');expect(calls).toBe(0);
 const token='synthetic-directory-secret';const error=await new OpenDotaTeamDirectoryClient(budget(),{apiKey:token},async()=>Response.json({token})).read().catch(e=>e as Error);
 expect(String(error)).not.toContain(token);expect(error).toMatchObject({code:'source_invalid_json'});
});
test('malformed and oversized bodies cannot enter the directory cache',async()=>{
 await expect(new OpenDotaTeamDirectoryClient(budget(),{},async()=>new Response('{invalid')).read()).rejects.toMatchObject({code:'source_invalid_json'});
 await expect(new OpenDotaTeamDirectoryClient(budget(),{},async()=>new Response('x'.repeat(8*1024*1024+1))).read()).rejects.toMatchObject({code:'source_response_too_large'});
});
test('timeout aborts transport and never exposes its raw error',async()=>{
 const client=new OpenDotaTeamDirectoryClient(budget(),{timeoutMs:5},async(_url,init)=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(Error('private transport details')));}),async()=>{});
 await expect(client.read()).rejects.toMatchObject({code:'source_timeout'});
});
