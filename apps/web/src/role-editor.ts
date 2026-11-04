import type {RoleProfilesReport} from '@dota/contracts';

export const ROLE_EDITOR_POLICY='role-editor-priority-v1';
type Evidence=Pick<RoleProfilesReport['players'][number],'playerId'|'identityStatus'|'candidates'>;
type Source=Evidence['candidates'][number]['source'];
const priority:readonly Source[]=['pandascore','stratz','pro_history'];
export const roleSourceName=(source:Source)=>({pandascore:'PandaScore',stratz:'STRATZ',pro_history:'Pro-история'}[source]);

/** Editor suggestions only. Server consensus/identity eligibility and historical facts are unchanged. */
export function roleEditorHints<T extends Evidence>(players:readonly T[]){
  const hints=players.map(player=>{
    const eligible=player.identityStatus==='verified'?player.candidates.filter(c=>c.eligible&&c.roles.length):[];
    const chosen=priority.map(source=>eligible.filter(c=>c.source===source))
      .find(group=>group.length===1&&group[0]!.roles.length===1)?.[0];
    const rolePos=chosen?.roles[0]??null;
    return {...player,rolePos,editorSource:chosen?.source??null,editorDuplicate:false,
      editorConflict:rolePos!==null&&eligible.some(c=>!c.roles.includes(rolePos)),
      editorAmbiguous:!chosen&&eligible.length>0};
  });
  const roles=hints.flatMap(p=>p.rolePos??[]);
  for(const player of hints)player.editorDuplicate=player.rolePos!==null&&roles.filter(role=>role===player.rolePos).length>1;
  return {policyVersion:ROLE_EDITOR_POLICY,players:hints,hasDuplicates:hints.some(p=>p.editorDuplicate),
    canArrange:hints.length===5&&new Set(hints.map(p=>p.playerId)).size===5&&hints.every(p=>p.rolePos!==null&&!p.editorDuplicate)};
}
