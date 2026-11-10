import type {RoleProfilesReport} from '@dota/contracts';
import type {RosterContext} from '../../api/src/modules/catalog/roster-context-contract';
import {roleEditorHints} from './role-editor';
type Member=RosterContext['members'][number];
type Player=RoleProfilesReport['players'][number];
export const MAX_ROSTER_ROLE_MEMBERS=30;
function eligibleMembers(members:readonly Member[]){
 return members.filter(m=>m.identityStatus==='verified'&&m.playerId&&members.filter(p=>p.playerId===m.playerId).length===1);
}
/** Bounded local reads, without filling missing players or selecting a five. */
export function rosterRoleBatches(members:readonly Member[]):string[][]{
 if(members.length>MAX_ROSTER_ROLE_MEMBERS)return [];
 const ids=eligibleMembers(members).map(m=>m.playerId!).sort(),batches:string[][]=[];
 for(let i=0;i<ids.length;i+=5)batches.push(ids.slice(i,i+5));
 return batches;
}
/** Verify the same numeric account in both reports before attaching any role. */
export function rosterRoleHints(members:readonly Member[],players:readonly Player[]){
 const eligible=eligibleMembers(members).flatMap(m=>{
  const found=players.filter(p=>p.playerId===m.playerId);
  return found.length===1&&found[0]!.identityStatus==='verified'&&found[0]!.accountIds.length===1&&found[0]!.accountIds[0]===m.accountId?found:[];
 });
 return new Map(roleEditorHints(eligible).players.map(p=>[p.playerId,p]));
}
