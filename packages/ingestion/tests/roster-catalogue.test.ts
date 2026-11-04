import {expect,test} from 'vitest';
import {createHash} from 'node:crypto';
import {catalogueCandidates,prepareRosterCatalogueSelection} from '../src/roster-catalogue';
const at='2026-01-01T00:00:00.000Z';
const observation=(endpoint:string,data:unknown)=>{const rawBody=JSON.stringify(data);return {rawBody,source:{endpoint,fetchedAt:at,payloadSha256:createHash('sha256').update(rawBody).digest('hex')}};};
const rows=Array.from({length:6},(_,i)=>({account_id:101+i,steamid:String(76561197960265728n+BigInt(101+i)),name:i<2?'same':'player'+i,team_id:71,team_name:'Synthetic team'}));
const registry=()=>observation('/proPlayers',rows),team=()=>observation('/teams/71',{team_id:71,name:'Synthetic team',tag:'SYN'});
test('nickname search lists ambiguous numeric candidates without choosing an identity',()=>{
 const r=catalogueCandidates(registry(),'players','same');expect(r.map(p=>p.id)).toEqual(['101','102']);
});
test('only explicitly selected five numeric accounts are provisioned, including transfers',()=>{
 const r=prepareRosterCatalogueSelection(registry(),team(),['101','102','103','104','105'],at);
 expect(r.accounts.map(p=>p.accountId)).toEqual(['101','102','103','104','105']);expect(r.source.knownAt).toBe(at);
});
test('duplicate or unknown accounts and tampered raw evidence are rejected',()=>{
 expect(()=>prepareRosterCatalogueSelection(registry(),team(),['101','101','103','104','105'],at)).toThrow();
 expect(()=>prepareRosterCatalogueSelection(registry(),team(),['999','102','103','104','105'],at)).toThrow();
 expect(()=>catalogueCandidates({...registry(),rawBody:'[]'},'players','same')).toThrow();
});
test('Steam64 must be supplied and numerically consistent; source team does not establish attendance',()=>{
 const missing=rows.map(p=>({...p,steamid:null}));expect(catalogueCandidates(observation('/proPlayers',missing),'players','same')).toEqual([]);
 expect(()=>prepareRosterCatalogueSelection(observation('/proPlayers',missing),team(),['101','102','103','104','105'],at)).toThrow();
 const raw=rows.map(p=>({...p,team_id:99}));raw[0]!.steamid='76561198000000000';
 expect(()=>prepareRosterCatalogueSelection(observation('/proPlayers',raw),team(),['101','102','103','104','105'],at)).toThrow();
 const valid=rows.map(p=>({...p,team_id:99}));
 expect(prepareRosterCatalogueSelection(observation('/proPlayers',valid),team(),['101','102','103','104','105'],at).accounts).toHaveLength(5);
});
