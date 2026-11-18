import {test,expect} from 'vitest';
import {lineupReviewKey,draftReviewRoles,reviewedRoster,reviewedBindingLineup} from '../src/lineup-review';
const source=()=>({providerTeamId:'70000',players:Array.from({length:5},(_,i)=>({providerPlayerId:String(9007199254740993n+BigInt(i)),selected:true,account:{id:String(1000+i)}}))});
const binding=()=>({providerTeamId:'70000',usable:true,players:source().players.map((p,i)=>({providerPlayerId:p.providerPlayerId,accountId:p.account.id,playerId:String(9007199254741993n+BigInt(i)),identityStatus:'verified'})).reverse()});
test('roles follow exact provider-player/account identities through a reordered canonical response',()=>{
 const s=source(),roles=draftReviewRoles(s),first=s.players[0]!.providerPlayerId,third=s.players[2]!.providerPlayerId;
 roles[first]=3;roles[third]=1;const r=reviewedRoster(s,roles)!;
 expect(reviewedBindingLineup(binding(),r)?.map(p=>[p.playerId,p.rolePos])).toEqual(Array.from({length:5},(_,i)=>[String(9007199254741993n+BigInt(i)),[3,2,1,4,5][i]]));
 expect(source()).toEqual(s);
});
test('a different account, team, unknown identity or unusable binding cannot adopt reviewed roles',()=>{
 const r=reviewedRoster(source(),draftReviewRoles(source()))!,b=binding();
 for(const changed of [{...b,usable:false},{...b,providerTeamId:'70001'},
  {...b,players:b.players.map((p,i)=>i? p:{...p,accountId:'9999'})},
  {...b,players:b.players.map((p,i)=>i? p:{...p,identityStatus:'conflict'})},
  ...(['playerId','providerPlayerId','accountId'] as const).map(key=>({...b,players:b.players.map(p=>({...p,[key]:b.players[0]![key]}))}))])expect(reviewedBindingLineup(changed,r)).toBeNull();
});
test('incomplete choices, repeated accounts and invalid/duplicate roles remain unconfirmed',()=>{
 const s=source(),roles=draftReviewRoles(s),id=s.players[0]!.providerPlayerId;
 for(const bad of [{...roles,[id]:0},{...roles,[id]:6},{...roles,[id]:2}])expect(reviewedRoster(s,bad)).toBeNull();
 expect(reviewedRoster({...s,players:s.players.slice(1)},roles)).toBeNull();
 expect(reviewedRoster({...s,players:s.players.map((p,i)=>i? p:{...p,account:null})},roles)).toBeNull();
 expect(reviewedRoster({...s,players:s.players.map(p=>({...p,account:{id:'1000'}}))},roles)).toBeNull();
});
test('review keys retain exact bigint strings, ignore presentation/order, and change on an account or selection edit',()=>{
 const s=source(),key=lineupReviewKey(s);
 expect(lineupReviewKey({...s,players:[...s.players].reverse()})).toBe(key);
 expect(lineupReviewKey({...s,players:s.players.map((p,i)=>i? p:{...p,selected:false})})).not.toBe(key);
 expect(lineupReviewKey({...s,players:s.players.map((p,i)=>i? p:{...p,account:{id:'9999'}})})).not.toBe(key);
 expect(draftReviewRoles(null)).toEqual({});expect(reviewedRoster(null,{})).toBeNull();expect(lineupReviewKey(null)).toBe('');
});
