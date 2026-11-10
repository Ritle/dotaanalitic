import {expect,test} from 'vitest';
import {rosterRoleBatches,rosterRoleHints} from '../src/roster-role-hints';
import type {RosterContext} from '../../api/src/modules/catalog/roster-context-contract';
import type {RoleProfilesReport} from '@dota/contracts';
type Member=RosterContext['members'][number];
const member=(i:number):Member=>({playerId:String(9007199254740993n+BigInt(i)),accountId:String(1000+i),identityStatus:'verified',name:'Synthetic '+i,localName:null,team:null});
const player=(i:number,role:number):RoleProfilesReport['players'][number]=>({playerId:member(i).playerId!,accountIds:[member(i).accountId],identityStatus:'verified',rolePos:role,basis:'history_fallback',autoEligible:true,historyRole:role,historyMaps:2,historyScope:'all_organizations',candidates:[{source:'pro_history',roles:[role],eligible:true,reason:null}],reasons:['SMALL_SAMPLE']});
test('bounded batches preserve all partial/bench members without padding a five',()=>{
 expect(rosterRoleBatches([member(0)])).toEqual([[member(0).playerId]]);
 expect(rosterRoleBatches(Array.from({length:6},(_,i)=>member(i))).map(b=>b.length)).toEqual([5,1]);
 expect(rosterRoleBatches(Array.from({length:31},(_,i)=>member(i)))).toEqual([]);
 expect(rosterRoleBatches([{...member(0),identityStatus:'conflict'},member(1)])).toEqual([[member(1).playerId]]);
 expect(rosterRoleBatches([member(0),{...member(1),playerId:member(0).playerId}])).toEqual([]);
});
test('numeric account mismatch and unresolved identities cannot acquire a role',()=>{
 const players=[player(0,1),player(1,2)],before=JSON.stringify(players);
 const result=rosterRoleHints([{...member(0),accountId:'9999'},{...member(1),identityStatus:'unknown'}],players);
 expect(result.size).toBe(0);expect(JSON.stringify(players)).toBe(before);
});
test('duplicate roles across request batches remain visible as a conflict, without invented replacement',()=>{
 const members=Array.from({length:6},(_,i)=>member(i)),players=members.map((_,i)=>player(i,i===5?1:i+1));
 const result=rosterRoleHints(members,players);
 expect(result.get(member(0).playerId!)?.editorDuplicate).toBe(true);
 expect(result.get(member(5).playerId!)?.editorDuplicate).toBe(true);
 expect(result.get(member(5).playerId!)?.rolePos).toBe(1);
});
test('unknown and disagreeing evidence use existing editor policy, never member order',()=>{
 const p=player(0,1);p.candidates.push({source:'pandascore',roles:[3],eligible:true,reason:null});
 const q=player(1,2);q.candidates=[];
 const hints=rosterRoleHints([member(1),member(0)],[p,q]);
 expect(hints.get(p.playerId)).toMatchObject({rolePos:3,editorSource:'pandascore',editorConflict:true});
 expect(hints.get(q.playerId)?.rolePos).toBeNull();
});
