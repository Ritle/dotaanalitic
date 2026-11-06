import {expect,test} from 'vitest';
import {RankedContextClient} from '../src/ranked-context-client.js';
const now=Date.parse('2026-11-06T00:00:00.000Z'),start=now/1000-7200,token='synthetic-context-token',
 row=(change:Record<string,unknown>={})=>({id:1,startDateTime:start,endDateTime:start+1800,durationSeconds:1800,didRadiantWin:false,lobbyType:'RANKED',gameMode:'ALL_PICK_RANKED',leagueId:null,gameVersionId:190,averageRank:null,players:[{steamAccountId:1000,playerSlot:128,isRadiant:false,isVictory:true,heroId:1,position:'POSITION_4'}],...change});
const budget=()=>({calls:0,statuses:[] as number[],async beforeRequest(){this.calls++;},async observe(status:number){this.statuses.push(status);}});
const lookup=(data:unknown,ids=['1'])=>new RankedContextClient(budget(),token,async()=>new Response(JSON.stringify({data})),15000,()=>now).lookup('1000',ids);
test('bounded aliases use exact decimal IDs, explicit account and one budgeted HTTP, source clock/hash preserved',async()=>{
 let body='',request:RequestInit|undefined;const b=budget(),id='9223372036854775807';
 const r=await new RankedContextClient(b,token,async(_,init)=>{request=init;body=String(init?.body);return new Response(JSON.stringify({data:{m0:row(),m1:row({id})}}));},15000,()=>now).lookup('1000',['1',id]);
 expect(body).toContain('match(id:'+id+')');expect(body).not.toContain(token);expect(JSON.parse(body).variables).toEqual({account:1000});expect(request).toMatchObject({method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token}});
 expect(b.calls).toBe(1);expect(r.receipt.entries[1]?.map?.matchId).toBe(id);expect(r.receipt).toMatchObject({knownAt:null,fetchedAt:'2026-11-06T00:00:00.000Z',entries:[{status:'found',map:{side:'dire',win:true,position:'POSITION_4',roleBasis:'estimated',patchCode:'190',partySize:null}},{status:'found'}]});expect(r.receipt.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
});
test('null source is missing; omitted alias or unsafe native ID is invalid, never an invented map',async()=>{
 const r=await lookup({m0:null,m2:row({id:Number.MAX_SAFE_INTEGER+1})},['1','2','3']);expect(r.receipt.entries.map(e=>[e.status,e.reason])).toEqual([['missing','source_map_unavailable'],['invalid','invalid_row'],['invalid','invalid_row']]);
});
test('unranked/league and wrong map/account/slot/outcome are quarantined per alias',async()=>{
 const p=row().players[0]!;
 for(const [change,reason] of [[{lobbyType:'UNRANKED'},'not_ranked_all_pick'],[{gameMode:'TURBO'},'not_ranked_all_pick'],[{leagueId:77},'league_conflict'],[{id:2},'map_mismatch'],[{players:[{...p,steamAccountId:1001}]},'account_mismatch'],[{players:[p,p]},'account_mismatch'],[{players:[{...p,playerSlot:9}]},'invalid_side'],[{players:[{...p,isRadiant:true}]},'invalid_side'],[{players:[{...p,isVictory:false}]},'outcome_conflict']] as const){
  const r=await lookup({m0:row(change)});expect(r.receipt.entries[0]).toMatchObject({status:'invalid',reason,map:null});
 }
});
test('time disagreement is quarantined; absent provider end uses duration and unknown role stays unknown',async()=>{
 expect((await lookup({m0:row({endDateTime:start+1700})})).receipt.entries[0]?.reason).toBe('time_mismatch');
 const p=row().players[0]!,r=await lookup({m0:row({endDateTime:null,gameVersionId:null,players:[{...p,position:'UNKNOWN'}]})});
 expect(r.receipt.entries[0]?.map).toMatchObject({completionBasis:'start_plus_duration',position:null,roleBasis:'unknown',patchCode:null});
});
test('invalid scope, too many IDs, duplicates or denied budget cannot use HTTP',async()=>{
 let calls=0;const c=new RankedContextClient(budget(),token,async()=>{calls++;return new Response('{}');});
 for(const [account,ids] of [['4294967296',['1']],['1000',[]],['1000',['1','2','3','4','5']],['1000',['1','1']],['1000',['1) {id}']]] as const)await expect(c.lookup(account,ids)).rejects.toThrow();expect(calls).toBe(0);
 await expect(new RankedContextClient({beforeRequest:async()=>{throw Error('quota');},observe:async()=>{}},token,async()=>{calls++;return new Response('{}');}).lookup('1000',['1'])).rejects.toThrow('quota');expect(calls).toBe(0);
});
test('HTTP/GraphQL/JSON/schema errors and echoed secrets are sanitized with no retry',async()=>{
 for(const [response,code] of [[new Response('{}',{status:429,headers:{'Retry-After':'120'}}),'source_rate_limited'],[new Response('{}',{status:403}),'source_access_denied'],[new Response('{}',{status:503}),'source_http_error'],[new Response('bad'),'source_invalid_json'],[new Response('{}'),'source_schema_invalid'],[new Response(JSON.stringify({data:{m0:row()},errors:[{message:'sensitive'}]})),'source_graphql_error'],[new Response(JSON.stringify({data:null})),'source_schema_invalid'],[new Response(JSON.stringify({token})),'source_invalid_payload']] as const){
  const b=budget();await expect(new RankedContextClient(b,token,async()=>response,15000,()=>now).lookup('1000',['1'])).rejects.toMatchObject({code});expect(b.calls).toBe(1);
 }
});
test('oversized and timed-out source replies are bounded',async()=>{
 await expect(new RankedContextClient(budget(),token,async()=>new Response(' '.repeat(2097153))).lookup('1000',['1'])).rejects.toMatchObject({code:'source_response_too_large'});
 await expect(new RankedContextClient(budget(),token,async(_,init)=>{await new Promise((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(Error('sensitive'))));return new Response('{}');},1).lookup('1000',['1'])).rejects.toMatchObject({code:'source_timeout'});
});
