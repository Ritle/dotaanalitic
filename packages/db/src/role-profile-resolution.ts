import {RoleProfilesReportSchema,type RoleProfilesReport,type RoleSuggestionReport} from '@dota/contracts';
type Inputs=Pick<RoleProfilesReport,'teamId'|'snapshotAt'|'configured'|'binding'|'sources'>;
export function resolveRoleProfiles(input:Inputs,history:RoleSuggestionReport,teamHistory:RoleSuggestionReport,
  identities:{playerId:string;accountIds:string[];identityStatus:'verified'|'unknown'|'conflict'}[]):RoleProfilesReport{
  const players=history.players.map(h=>{
    const id:{accountIds:string[];identityStatus:'verified'|'unknown'|'conflict'}=identities.find(i=>i.playerId===h.playerId)??{accountIds:[],identityStatus:'unknown'};
    const th=teamHistory.players.find(p=>p.playerId===h.playerId),selected=th&&th.nUsed>0?th:h;
    const candidates:RoleProfilesReport['players'][number]['candidates']=[];
    for(const source of input.sources.filter(s=>s.provider!=='stratz'||id.accountIds.some(a=>s.sourceKey===`stratz:player:${a}`))){
      const expected=source.provider==='stratz'?input.binding.binding.stratzTeamId:input.binding.binding.pandaTeamId;
      const pandaId=input.binding.binding.pandaPlayers.find(p=>p.playerId===h.playerId)?.providerPlayerId;
      const matches=source.observation?.players.filter(p=>source.provider==='stratz'?p.accountId!==null&&id.accountIds.includes(p.accountId):p.providerPlayerId===pandaId)??[];
      const scoped=source.provider==='pandascore'?matches.filter(p=>p.providerTeamId===expected):matches;
      const roles=[...new Set(scoped.flatMap(p=>p.roles))].sort();
      const reason=id.identityStatus!=='verified'?'IDENTITY_UNRESOLVED':!expected?'TEAM_BINDING_MISSING':source.status!=='ready'?'SOURCE_NOT_FRESH':
        source.provider==='pandascore'&&!pandaId?'PLAYER_BINDING_MISSING':scoped.length!==1?'PROFILE_MISSING_OR_DUPLICATE':
        scoped[0]!.providerTeamId!==expected?'PROFILE_TEAM_MISMATCH':roles.length===0?'PROFILE_ROLE_UNKNOWN':null;
      candidates.push({source:source.provider,roles,eligible:reason===null,reason});
    }
    candidates.push({source:'pro_history',roles:selected.suggestedRole===null?[]:[selected.suggestedRole],eligible:selected.suggestedRole!==null,reason:selected.suggestedRole===null?'HISTORY_ROLE_UNKNOWN':null});
    const eligible=candidates.filter(c=>c.eligible&&c.roles.length),profiles=eligible.filter(c=>c.source!=='pro_history');
    const singleton=profiles.find(c=>c.roles.length===1)?.roles[0];
    const intersection=eligible.length?[1,2,3,4,5].filter(r=>eligible.every(c=>c.roles.includes(r))):[];
    let rolePos:number|null=null,basis:RoleProfilesReport['players'][number]['basis']='unknown',autoEligible=false;
    if(profiles.length){
      if(intersection.length===0)basis='conflict';
      else if(intersection.length===1){rolePos=intersection[0]!;basis=eligible.length>=2?'agreement':'profile_only';autoEligible=basis==='agreement'&&singleton===rolePos;}
    }else if(selected.suggestedRole!==null){rolePos=selected.suggestedRole;basis='history_fallback';}
    const reasons=[...new Set([...selected.reasons,...candidates.flatMap(c=>c.reason??[]),...(basis==='conflict'?['ROLE_SOURCES_CONFLICT']:[])])];
    return {playerId:h.playerId,accountIds:id.accountIds,identityStatus:id.identityStatus,rolePos,basis,autoEligible,historyRole:selected.suggestedRole,historyMaps:selected.nUsed,
      historyScope:th&&th.nUsed>0?'selected_team' as const:'all_organizations' as const,candidates,reasons};
  });
  const roles=players.flatMap(p=>p.rolePos??[]),unique=roles.length===5&&new Set(roles).size===5;
  const warnings=['CURRENT_PROFILE_NOT_HISTORICAL_FACT','PROFILE_ACCURACY_NOT_MEASURED','NOT_USED_BY_V1_ELO'];
  if(new Set(roles).size!==roles.length)warnings.push('DUPLICATE_SUGGESTED_ROLES');
  return RoleProfilesReportSchema.parse({...input,policyVersion:'role-profile-consensus-v1',history,players,canAutoApply:unique&&players.every(p=>p.autoEligible),warnings});
}
