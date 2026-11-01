import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {prepareCurrentAccounts} from '../src/opendota/current-accounts.js';
const time='2026-01-01T00:00:00.000Z',reviewedAt='2026-01-02T00:00:00.000Z';
const account=(id:number,team=0)=>({account_id:id,steamid:String(76561197960265728n+BigInt(id)),name:'Synthetic namesake',team_id:team});
function capture(rows:unknown[]=[account(101),account(102,77)]){const rawBody=JSON.stringify(rows);return {
 schemaVersion:1,mode:'current_catalogue_capture',teams:[],registry:{rawBody,source:{provider:'opendota',endpoint:'/proPlayers',
 fetchedAt:time,knownAt:null,payloadSha256:createHash('sha256').update(rawBody).digest('hex')}}};}
const selection={accountIds:['102','101'],reviewedAt};
it('selects exact numeric accounts regardless of organization, preserves distinct namesakes and observation clock',()=>{
 const result=prepareCurrentAccounts(capture(),'a'.repeat(64),selection);
 expect(result.review.accounts.map(a=>a.accountId)).toEqual(['101','102']);
 expect(result.review.policyVersion).toBe('reviewed-current-accounts-v1');expect(result.review).not.toHaveProperty('teams');
 expect(result.review.source.knownAt).toBe(time);expect(result.warnings).toContain('NO_HISTORICAL_BACKDATE');
});
it('refuses missing selected accounts without partially provisioning others',()=>{
 expect(()=>prepareCurrentAccounts(capture(),'a'.repeat(64),{...selection,accountIds:['101','999']})).toThrow('account_selection_missing');
});
it('rejects duplicate selections and duplicate selected source rows',()=>{
 expect(()=>prepareCurrentAccounts(capture(),'a'.repeat(64),{...selection,accountIds:['101','101']})).toThrow();
 expect(()=>prepareCurrentAccounts(capture([account(101),account(101)]),'a'.repeat(64),{...selection,accountIds:['101']})).toThrow();
});
it('rejects altered bytes, wrong endpoints, asserted knownAt and impossible clocks',()=>{
 const c=capture();c.registry.rawBody+=' ';expect(()=>prepareCurrentAccounts(c,'a'.repeat(64),selection)).toThrow();
 const d=capture();d.registry.source.endpoint='/players';expect(()=>prepareCurrentAccounts(d,'a'.repeat(64),selection)).toThrow();
 expect(()=>prepareCurrentAccounts(capture(),'a'.repeat(64),{...selection,reviewedAt:'2025-12-31T00:00:00.000Z'})).toThrow();
 expect(()=>prepareCurrentAccounts({...capture(),registry:{...capture().registry,source:{...capture().registry.source,knownAt:time}}},'a'.repeat(64),selection)).toThrow();
});
it.each([null,'76561197960265728'])('does not synthesize or accept an inconsistent supplied Steam64: %s',steamid=>{
 expect(()=>prepareCurrentAccounts(capture([{...account(101),steamid}]),'a'.repeat(64),{...selection,accountIds:['101']})).toThrow();
});
it('requires alias, bounded Steam32 string selection and evidence SHA',()=>{
 expect(()=>prepareCurrentAccounts(capture([{...account(101),name:''}]),'a'.repeat(64),{...selection,accountIds:['101']})).toThrow();
 for(const ids of [[],['4294967296'],[101],Array.from({length:101},(_,i)=>String(i+1))])
  expect(()=>prepareCurrentAccounts(capture(),'a'.repeat(64),{...selection,accountIds:ids})).toThrow();
 expect(()=>prepareCurrentAccounts(capture(),'wrong',selection)).toThrow();
});
