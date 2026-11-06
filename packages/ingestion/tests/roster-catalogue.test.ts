import {expect,test} from 'vitest';
import {createHash} from 'node:crypto';
import {catalogueCandidates,prepareRosterCatalogueSelection,prepareRosterAccounts,catalogueAccountQuery,catalogueProfileCandidate,prepareRosterReviews} from '../src/roster-catalogue';
const at='2026-01-01T00:00:00.000Z';
const observation=(endpoint:string,data:unknown)=>{const rawBody=JSON.stringify(data);return {rawBody,source:{endpoint,fetchedAt:at,payloadSha256:createHash('sha256').update(rawBody).digest('hex')}};};
const rows=Array.from({length:6},(_,i)=>({account_id:101+i,steamid:String(76561197960265728n+BigInt(101+i)),name:i<2?'same':'player'+i,team_id:71,team_name:'Synthetic team'}));
const registry=()=>observation('/proPlayers',rows),team=()=>observation('/teams/71',{team_id:71,name:'Synthetic team',tag:'SYN'});
const profile=()=>observation('/players/199',{profile:{account_id:199,steamid:String(76561197960265728n+199n),name:null,personaname:'new nickname'}});

test('changed persona is searchable while distinct same-name accounts stay explicit',()=>{
 const r=catalogueCandidates(observation('/proPlayers',rows.map(p=>({...p,personaname:'new nickname'}))),'players','new nickname');
 expect(r).toHaveLength(6);expect(new Set(r.map(p=>p.id)).size).toBe(6);
});
test('numeric account and trusted profile URLs resolve without fetching arbitrary URLs',()=>{
 for(const q of ['199','76561197960265927','https://stratz.com/players/199?utm_source=twitch','https://www.opendota.com/players/199','https://steamcommunity.com/profiles/76561197960265927'])expect(catalogueAccountQuery(q)).toBe('199');
 for(const q of ['inori','0','4294967296','https://stratz.com.evil/players/199','https://evil.test/players/199','https://stratz.com/players/199/extra','https://steamcommunity.com/profiles/199'])expect(catalogueAccountQuery(q)).toBeNull();
});
test('profile supplies numeric evidence absent from registry, never pro status or attendance',()=>{
 expect(catalogueProfileCandidate(profile(),'199')).toMatchObject({id:'199',name:'new nickname',profileSha256:profile().source.payloadSha256,teamId:null});
 expect(()=>catalogueProfileCandidate(profile(),'198')).toThrow();
 expect(()=>catalogueProfileCandidate({...profile(),rawBody:'{}'},'199')).toThrow();
 for(const bad of [{profile:null},{profile:{account_id:199,personaname:'new nickname'}},{profile:{account_id:199,steamid:'76561198000000000',personaname:'new nickname'}}])expect(()=>catalogueProfileCandidate(observation('/players/199',bad),'199')).toThrow();
});
test('mixed selections retain independent source hashes and current clocks',()=>{
 const selected=['101','102','103','104'].map(accountId=>({accountId}));
 const reviews=prepareRosterReviews(registry(),team(),[...selected,{accountId:'199',profileSha256:profile().source.payloadSha256}],[profile()],at);
 expect(reviews.map(r=>r.policyVersion)).toEqual(['reviewed-current-catalogue-v1','reviewed-current-profile-v1']);
 expect(reviews[0]!.accounts).toHaveLength(4);expect(reviews[1]!.source.url).toBe('https://api.opendota.com/api/players/199');
 expect(reviews.every(r=>r.source.knownAt===at)).toBe(true);
 expect(()=>prepareRosterReviews(registry(),null,[...selected,{accountId:'199',profileSha256:'0'.repeat(64)}],[profile()],at)).toThrow();
 expect(()=>prepareRosterReviews(registry(),null,[...selected,{accountId:'199'}],[],at)).toThrow();
});
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
test('accounts can be reviewed without a known organization or current team membership',()=>{
 const r=prepareRosterAccounts(observation('/proPlayers',rows.map(p=>({...p,team_id:0}))),['101','102','103','104','105'],at);
 expect(r.policyVersion).toBe('reviewed-current-accounts-v1');expect(r.accounts).toHaveLength(5);expect(r.source.knownAt).toBe(at);expect(r).not.toHaveProperty('teams');
});
test('organization-free account selection retains numeric proof and raw-source guards',()=>{
 expect(()=>prepareRosterAccounts(registry(),['101','101','103','104','105'],at)).toThrow();
 expect(()=>prepareRosterAccounts(registry(),['999','102','103','104','105'],at)).toThrow();
 expect(()=>prepareRosterAccounts({...registry(),rawBody:'[]'},['101','102','103','104','105'],at)).toThrow();
 expect(()=>prepareRosterAccounts(observation('/proPlayers',rows.map(p=>({...p,steamid:'76561198000000000'}))),['101','102','103','104','105'],at)).toThrow();
});
