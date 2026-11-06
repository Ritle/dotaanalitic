import type {RoleProfilesReport} from '@dota/contracts';

export const ROLE_EDITOR_POLICY='role-editor-priority-v1';
type Evidence=Pick<RoleProfilesReport['players'][number],'playerId'|'identityStatus'|'candidates'>;
type Source=Evidence['candidates'][number]['source'];
const priority:readonly Source[]=['pandascore','stratz','pro_history'];
export const roleSourceName=(source:Source)=>({pandascore:'PandaScore',stratz:'STRATZ',pro_history:'Pro-история'}[source]);

/** Display labels only: never resolve or merge identities by a provider nickname. */
export function rolePlayerName(report:Pick<RoleProfilesReport,'binding'|'sources'>,
 player:Pick<RoleProfilesReport['players'][number],'playerId'|'accountIds'|'identityStatus'>):string|null{
 if(player.identityStatus!=='verified'||player.accountIds.length!==1)return null;
 const binding=report.binding.binding,link=binding.pandaPlayers.find(p=>p.playerId===player.playerId),account=player.accountIds[0]!;
 const observations=report.sources.filter(s=>s.status==='ready'&&s.observation?.provider===s.provider&&s.observation.sourceKey===s.sourceKey);
 const panda=link&&binding.pandaTournamentId&&binding.pandaTeamId?observations.filter(s=>s.provider==='pandascore'&&s.sourceKey===`pandascore:roster:${binding.pandaTournamentId}`)
  .flatMap(s=>s.observation!.players.filter(p=>p.providerPlayerId===link.providerPlayerId&&p.providerTeamId===binding.pandaTeamId)):[];
 if(panda.length===1&&panda[0]!.name?.trim())return panda[0]!.name!.trim();
 const steam=observations.filter(s=>s.provider==='stratz'&&s.sourceKey===`stratz:player:${account}`)
  .flatMap(s=>s.observation!.players.filter(p=>p.accountId===account&&p.providerPlayerId===account));
 return steam.length===1?steam[0]!.name?.trim()||null:null;
}

/** A selected catalogue name is a display label, never new identity or provider evidence. */
const readableRoleName=(name:string|undefined|null)=>!!name&&/[\p{L}\p{N}\p{P}\p{S}]/u.test(name);
export function selectedRolePlayerLabel(playerId:string,selectedLabel?:string):string{
 const name=selectedLabel?.trim();return readableRoleName(name)?`Выбранный игрок: ${name} · ID ${playerId}`:`Игрок ${playerId}`;
}
export function rolePlayerLabel(report:Pick<RoleProfilesReport,'binding'|'sources'>,
 player:Pick<RoleProfilesReport['players'][number],'playerId'|'accountIds'|'identityStatus'>,selectedLabel?:string):string{
 const name=rolePlayerName(report,player);
 return readableRoleName(name)?`${name} · ID ${player.playerId}`:selectedRolePlayerLabel(player.playerId,selectedLabel);
}

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
