import {test,expect} from 'vitest';
import {OpenDotaPlayerSearchClient} from '../src/opendota/player-search';
import {discoveryCandidates,discoveryKey,playerNameMatches,preferExactPlayerCandidates,rankPlayerCandidatesByHistory} from '../src/player-discovery';
const budget=()=>({beforeRequest:async()=>{},observe:async()=>{}});
test('candidate history preference is stable, preserves all IDs and does not turn unknown into zero',()=>{
 const rows=[{id:'1',name:'Twin',teamId:null,teamName:null,proMaps:0},{id:'2',name:'Twin',teamId:null,teamName:null},{id:'3',name:'Twin',teamId:null,teamName:null,proMaps:2},{id:'4',name:'Twin',teamId:null,teamName:null,proMaps:20}];
 const ranked=rankPlayerCandidatesByHistory(rows,'Twin');expect(ranked.map(p=>p.id)).toEqual(['3','4','1','2']);
 expect(rows.map(p=>p.id)).toEqual(['1','2','3','4']);expect(ranked.find(p=>p.id==='2')!.proMaps).toBeUndefined();
});
test('partial names with history do not outrank an exact name; exact aliases remain peers',()=>{
 const rows=[{id:'1',name:'mercy',teamId:null,teamName:null,proMaps:10},{id:'2',name:'RCY',teamId:null,teamName:null,proMaps:0},{id:'3',name:'Changed',aliases:['rcy'],teamId:null,teamName:null,proMaps:2}];
 expect(rankPlayerCandidatesByHistory(rows,'RCY').map(p=>p.id)).toEqual(['3','2','1']);
});
test('exact current names take precedence over unrelated partial nickname matches',()=>{
 const rows=[{id:'1',name:'RCY',teamId:null,teamName:null},{id:'2',name:'mercy',teamId:null,teamName:null}];
 expect(preferExactPlayerCandidates(rows,' rcy ').map(p=>p.id)).toEqual(['1']);expect(preferExactPlayerCandidates(rows,'rc')).toEqual(rows);
});
test('equal exact aliases remain ambiguous and never merge account identities',()=>{
 const rows=[{id:'1',name:'RCY',teamId:null,teamName:null},{id:'2',name:'Changed name',aliases:['Rcy'],teamId:null,teamName:null}];
 expect(preferExactPlayerCandidates(rows,'RCY').map(p=>p.id)).toEqual(['1','2']);
});
test('a numeric roster nickname is matched by name, not by an unrelated account number',()=>{
 const rows=[{id:'86',name:'Unrelated account',teamId:null,teamName:null},{id:'1000',name:'86',teamId:null,teamName:null}];
 expect(preferExactPlayerCandidates(rows,'86').map(p=>p.id)).toEqual(['1000']);expect(preferExactPlayerCandidates(rows.slice(0,1),'86')).toEqual([]);
});
test('search uses fixed host, encoded name and shared budget; candidates remain unverified',async()=>{
 let reserved=0,seen='';const r=await new OpenDotaPlayerSearchClient({...budget(),beforeRequest:async()=>{reserved++;}},{},async url=>{seen=String(url);return Response.json([{account_id:123,personaname:'Synthetic & player'}]);}).read('Synthetic & Player');
 expect(seen).toBe('https://api.opendota.com/api/search?q=synthetic%20%26%20player');expect(reserved).toBe(1);
 expect(discoveryCandidates(r,'Synthetic & Player')[0]).toMatchObject({id:'123',discovery:true});
 expect(discoveryKey(' SYNTHETIC ')).toBe(discoveryKey('synthetic'));
 expect(()=>discoveryCandidates(r,'different')).toThrow();expect(()=>discoveryCandidates({...r,rawBody:'[]'},'Synthetic & Player')).toThrow();
});
test('empty results, duplicate IDs and same nick on different IDs are represented honestly',async()=>{
 const fetchRows=async(rows:unknown)=>new OpenDotaPlayerSearchClient(budget(),{},async()=>Response.json(rows)).read('Synthetic');
 expect(discoveryCandidates(await fetchRows([]),'Synthetic')).toEqual([]);
 const r=await fetchRows([{account_id:1,personaname:'Twin'},{account_id:2,personaname:'Twin'},{account_id:1,personaname:'Twin'}]);
 expect(discoveryCandidates(r,'Synthetic').map(p=>p.id)).toEqual(['1','2']);
 await expect(fetchRows([{account_id:9007199254740992,personaname:'Unsafe'}])).rejects.toMatchObject({code:'source_schema_invalid'});
});
test('normalization and reordered words discover aliases without merging IDs',()=>{
 expect(playerNameMatches('htiviy_vladik','VladikTheHtiviy')).toBe(true);
 expect(playerNameMatches('V1olent–','v1olent')).toBe(true);
 expect(playerNameMatches('someone','different')).toBe(false);
 expect(playerNameMatches('Synthetic Player 3','Synthetic Player 4')).toBe(false);
});
test('429 respects Retry-After and quota failure never makes HTTP calls',async()=>{
 let calls=0;await expect(new OpenDotaPlayerSearchClient(budget(),{},async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'60'}});}).read('Synthetic')).rejects.toMatchObject({code:'source_rate_limited',retryAfterMs:60000});expect(calls).toBe(1);
 await expect(new OpenDotaPlayerSearchClient({...budget(),beforeRequest:async()=>{throw Error('quota');}},{},async()=>{calls++;return Response.json([]);}).read('Synthetic')).rejects.toThrow('quota');expect(calls).toBe(1);
});
test('5xx retry, timeout, malformed JSON and size limits do not expose provider details',async()=>{
 let calls=0;const r=await new OpenDotaPlayerSearchClient(budget(),{},async()=>++calls===1?new Response('',{status:503}):Response.json([]),async()=>{}).read('Synthetic');expect(r.source.attempts).toBe(2);
 await expect(new OpenDotaPlayerSearchClient(budget(),{},async()=>new Response('x'.repeat(1024*1024+1))).read('Synthetic')).rejects.toMatchObject({code:'source_response_too_large'});
 await expect(new OpenDotaPlayerSearchClient(budget(),{},async()=>new Response('{')).read('Synthetic')).rejects.toMatchObject({code:'source_invalid_json'});
 const client=new OpenDotaPlayerSearchClient(budget(),{timeoutMs:5},async(_url,init)=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(Error('secret transport')));}),async()=>{});
 await expect(client.read('Synthetic')).rejects.toMatchObject({code:'source_timeout'});
});
