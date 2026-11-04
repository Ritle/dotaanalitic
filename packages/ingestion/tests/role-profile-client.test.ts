import {expect,test} from 'vitest';
import {RoleProfileClient,RoleProfileSourceError} from '../src/role-profile-client.js';
import {parsePandaRoles} from '@dota/contracts';
const profile=(account=1000)=>({data:{player:{steamAccountId:account,steamAccount:{proSteamAccount:{id:account,name:'Synthetic',teamId:10,position:'POSITION_3'}}}}});
const budget=()=>({calls:0,statuses:[] as number[],async beforeRequest(){this.calls++;},async observe(status:number){this.statuses.push(status);}});
test('STRATZ single-profile API binds returned numeric account and keeps source clocks/hash',async()=>{
 const b=budget();let request:RequestInit|undefined;
 const client=new RoleProfileClient('stratz','synthetic-token',b,async(input,init)=>{expect(String(input)).toBe('https://api.stratz.com/graphql');request=init;return new Response(JSON.stringify(profile()));});
 const result=await client.read('1000');expect(result.players[0]).toMatchObject({accountId:'1000',providerTeamId:'10',roles:[3]});
 expect(result.knownAt).toBeNull();expect(result.payloadSha256).toMatch(/^[a-f0-9]{64}$/);expect(b.calls).toBe(1);expect(request?.body).not.toContain('synthetic-token');
});
test('mixed Panda positions remain alternatives and missing roles are unknown',async()=>{
 const r=await new RoleProfileClient('pandascore','synthetic-token',budget(),async()=>new Response(JSON.stringify({type:'Team',rosters:[{id:9,name:'Synthetic',players:[
   {id:7,name:'Synthetic',role:'1/2'},{id:8,name:null}]}]}))).read('10');
 expect(r.players.map(p=>p.roles)).toEqual([[1,2],[]]);expect(parsePandaRoles('carry')).toEqual([]);expect(parsePandaRoles('2/2')).toEqual([2]);
});
test('GraphQL errors, account mismatch, invalid JSON and echoed secrets are sanitized',async()=>{
 for(const [payload,code] of [[{errors:[{message:'private detail'}]},'source_graphql_error'],[profile(1001),'source_id_mismatch'],
   [{...profile(),token:'synthetic-token'},'source_invalid_payload'],[{},'source_schema_invalid']] as const){
   const client=new RoleProfileClient('stratz','synthetic-token',budget(),async()=>new Response(JSON.stringify(payload)));
   await expect(client.read('1000')).rejects.toMatchObject({code});
 }
 const client=new RoleProfileClient('stratz','synthetic-token',budget(),async()=>new Response('{'));
 await expect(client.read('1000')).rejects.toMatchObject({code:'source_invalid_json'});
});
test('429 honors retry-after budget observation without retry; 5xx, timeout and oversized data are bounded',async()=>{
 const b=budget();let calls=0;
 await expect(new RoleProfileClient('stratz','synthetic-token',b,async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'60'}});}).read('1000'))
 .rejects.toMatchObject({code:'source_rate_limited',retryMs:60000});expect(calls).toBe(1);expect(b.statuses).toEqual([429]);
 await expect(new RoleProfileClient('stratz','synthetic-token',b,async()=>new Response('{}',{status:503})).read('1000')).rejects.toBeInstanceOf(RoleProfileSourceError);
 await expect(new RoleProfileClient('stratz','synthetic-token',b,async()=>new Response('x'.repeat(2097153))).read('1000')).rejects.toMatchObject({code:'source_response_too_large'});
 await expect(new RoleProfileClient('stratz','synthetic-token',b,async(_input,init)=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(Error('aborted')));}),5).read('1000'))
 .rejects.toMatchObject({code:'source_timeout'});
});
