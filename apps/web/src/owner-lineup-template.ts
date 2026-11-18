import {TemplateLineupSchema,type LineupTemplate} from '../../api/src/modules/catalog/lineup-templates-contract';
import type {RoleMember} from './role-suggestions';
export function templateLineup(rows:readonly RoleMember[]){
 const result=TemplateLineupSchema.safeParse(rows.map(p=>({playerId:p.playerId,rolePos:p.rolePos})));
 return result.success?result.data:null;
}
export function applyOwnerTemplate<T extends RoleMember>(teamId:string,rows:readonly T[],template:LineupTemplate|null|undefined):T[]|null{
 if(!template||template.teamId!==teamId||!templateLineup(rows)||!TemplateLineupSchema.safeParse(template.lineup).success)return null;
 if(rows.some(p=>!template.lineup.some(t=>t.playerId===p.playerId)))return null;
 return rows.map(p=>({...p,rolePos:template.lineup.find(t=>t.playerId===p.playerId)!.rolePos}));
}
export function sameTemplateRoles(teamId:string,rows:readonly RoleMember[],template:LineupTemplate|null|undefined){
 const applied=applyOwnerTemplate(teamId,rows,template);return !!applied&&applied.every((p,i)=>p.rolePos===rows[i]!.rolePos);
}
