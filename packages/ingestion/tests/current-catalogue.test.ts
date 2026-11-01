import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {prepareCurrentCatalogue} from '../src/opendota/current-catalogue.js';
import {OpenDotaClient} from '../src/opendota/client.js';
const time='2026-01-01T00:00:00.000Z',reviewedAt='2026-01-02T00:00:00.000Z';
const account=(id:number,team=9)=>({account_id:id,steamid:String(76561197960265728n+BigInt(id)),name:'Synthetic same name',team_id:team});
const observation=(endpoint:string,data:unknown)=>{const rawBody=JSON.stringify(data);return {rawBody,
  source:{provider:'opendota',endpoint,fetchedAt:time,knownAt:null,payloadSha256:createHash('sha256').update(rawBody).digest('hex')}};};
const capture=()=>({schemaVersion:1,mode:'current_catalogue_capture',registry:observation('/proPlayers',[account(101),account(102),account(103,10)]),
  teams:[observation('/teams/9',{team_id:9,name:'Synthetic team',tag:'TEST'})]});
it('selects numeric team members, keeps namesakes distinct and uses current observation clocks',()=>{
  const r=prepareCurrentCatalogue(capture(),'a'.repeat(64),reviewedAt);
  expect(r.review.accounts.map(a=>a.accountId)).toEqual(['101','102']);expect(r.sourceRowCount).toBe(3);
  expect(r.review.source.knownAt).toBe(time);expect(r.reportedMemberships).toHaveLength(2);
  expect(r.warnings).toContain('MEMBERSHIP_IS_NOT_MAP_LINEUP');
});
it('rejects tampered bytes, endpoints, duplicate teams and future observations',()=>{
  const a=capture();a.registry.rawBody+=' ';expect(()=>prepareCurrentCatalogue(a,'a'.repeat(64),reviewedAt)).toThrow('catalogue_source_binding');
  const b=capture();b.teams[0]!.source.endpoint='/teams/8';expect(()=>prepareCurrentCatalogue(b,'a'.repeat(64),reviewedAt)).toThrow();
  const c=capture();c.teams.push(c.teams[0]!);expect(()=>prepareCurrentCatalogue(c,'a'.repeat(64),reviewedAt)).toThrow();
  expect(()=>prepareCurrentCatalogue(capture(),'a'.repeat(64),'2025-12-31T00:00:00.000Z')).toThrow();
});
it('requires supplied consistent Steam64 and nonempty aliases; refuses duplicate/overflow accounts',()=>{
  for(const rows of [[{...account(101),steamid:null}],[{...account(101),steamid:'76561197960265728'}],
    [{...account(101),name:''}],[account(101),account(101)],[{...account(101),account_id:4294967296}]]){
    const c=capture();c.registry=observation('/proPlayers',rows);expect(()=>prepareCurrentCatalogue(c,'a'.repeat(64),reviewedAt)).toThrow();
  }
});
it('validates real client projection and strips unrelated fields without converting flags',async()=>{
  const client=new OpenDotaClient({maxRequests:1},{fetch:async url=>{expect(url.pathname).toBe('/api/proPlayers');
    return new Response(JSON.stringify([{...account(101),is_pro:true,unrelated:'ignored'}]));}});
  const result=await client.getProPlayers();expect(result.data[0]!.account_id).toBe('101');expect(result.data[0]).not.toHaveProperty('unrelated');
  const invalid=new OpenDotaClient({maxRequests:1},{fetch:async()=>new Response(JSON.stringify([{...account(101),is_pro:'true'}]))});
  await expect(invalid.getProPlayers()).rejects.toMatchObject({code:'source_schema_invalid'});
});
