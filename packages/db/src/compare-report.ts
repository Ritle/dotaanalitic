import {sampleEvidence} from '@dota/analytics';
import {CompareReportSchema,type CompareRequest,type GameRegistry,type StoredAccountEvidence,type ProMapItem,type StrengthReport} from '@dota/contracts';
import {collectProMaps,type ProMapCandidate} from './pro-maps.js';
import {resolveIdentity} from './identity.js';
import {resolvePatchAt} from './game-context.js';
import {buildRosterReport} from './roster-report.js';
import {buildStrengthReport,strengthMetadata,type StrengthCandidate} from './strength-report.js';
export type StrengthHistory={candidates:StrengthCandidate[];evidence:StoredAccountEvidence[];identityRevision:string}|null;
type Input=CompareRequest&{fromAt:string;cutoffAt:string};
const fingerprint=(ids:readonly (string|null)[])=>ids.every((id):id is string=>id!==null)?[...ids].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1).join(':'):null;
export function buildCompareReport(input:Input,snapshotAt:string,candidates:readonly ProMapCandidate[],evidence:readonly StoredAccountEvidence[],registry:GameRegistry,
  identityRevision:string,names:ReadonlyMap<string,string>,strengthHistory:StrengthHistory){
  const byAccount=new Map<string,StoredAccountEvidence[]>();
  for(const e of evidence)if(e.fetchedAt<=snapshotAt&&(e.knownAt===null||e.knownAt<=snapshotAt)&&(e.eventAt===null||e.eventAt<=snapshotAt)){
    const group=byAccount.get(e.externalAccountId)??[];group.push(e);byAccount.set(e.externalAccountId,group);
  }
  const identities=new Map([...byAccount].map(([account,proofs])=>[account,resolveIdentity(proofs,account,null)]));
  const actualFives=new Map(candidates.map(m=>{
    const players=m.players.map(p=>({...p,playerId:p.sourceAccountId===null?null:identities.get(p.sourceAccountId)?.playerId??null}));
    const ids=players.flatMap(p=>p.playerId??[]),duplicate=new Set(ids).size!==ids.length;
    const side=(base:number)=>Array.from({length:5},(_,i)=>{const found=players.filter(p=>p.playerSlot===base+i);return !duplicate&&found.length===1?found[0]!.playerId:null;});
    return [m.matchId,{radiant:side(0),dire:side(128)}] as const;
  }));
  const currentPatch=resolvePatchAt(registry.patches.filter(p=>p.fetchedAt<=snapshotAt),input.cutoffAt,snapshotAt);
  const rosterCandidates=candidates.filter(m=>(!input.leagueId||m.leagueId===input.leagueId)&&(!input.patchId||
    resolvePatchAt(registry.patches.filter(p=>p.fetchedAt<=snapshotAt),m.startedAt,snapshotAt).value===input.patchId));
  const sample=(maps:readonly ProMapItem[],known=true)=>({nRaw:known?maps.length:null,wins:known?maps.filter(m=>m.won).length:null,
    winRate:known&&maps.length?maps.filter(m=>m.won).length/maps.length:null,dataUpdatedAt:known?maps.map(m=>m.syncedAt).sort().at(-1)??null:null,sampleEvidence:sampleEvidence(known?maps.length:null)});
  function team(id:string,lineup:CompareRequest['lineupA']){
    const scoped=candidates.filter(m=>m.radiantTeamId===id||m.direTeamId===id),query={fromAt:input.fromAt,cutoffAt:input.cutoffAt,patchId:input.patchId,leagueId:input.leagueId,limit:20};
    const collected=collectProMaps('teams',id,query,snapshotAt,scoped,registry,evidence);
    const maps=collected.eligible.map(({targetPlayerSlot:_slot,...m})=>m),cohesion=buildRosterReport(id,{lineup,expectedLineup:null,fromAt:input.fromAt,cutoffAt:input.cutoffAt},
      input.cutoffAt,snapshotAt,rosterCandidates,evidence,registry,identityRevision);
    const selected=maps.filter(m=>cohesion.actual.fingerprint!==null&&fingerprint(actualFives.get(m.matchId)![m.side])===cohesion.actual.fingerprint);
    const strengthQuery={fromAt:input.fromAt,cutoffAt:input.cutoffAt,limit:20},strength=strengthHistory?
      buildStrengthReport(id,strengthQuery,snapshotAt,strengthHistory.candidates,strengthHistory.evidence,strengthHistory.identityRevision):
      {...strengthMetadata(id,strengthQuery,snapshotAt),status:'unavailable' as const,reason:'GLOBAL_HISTORY_TOO_LARGE' as const,message:'Глобальная история Elo превышает 5000 карт; raw выборки доступны.'};
    const opponents=new Map<string|null,ProMapItem[]>();for(const m of maps){const group=opponents.get(m.opponentId)??[];group.push(m);opponents.set(m.opponentId,group);}
    return {maps,report:{organizationId:id,name:names.get(id)??id,organization:sample(maps),recent:sample(maps.slice(0,20)),
      currentPatch:currentPatch.value===null?null:sample(maps.filter(m=>m.patchId===currentPatch.value)),selectedFiveOrganization:sample(selected,cohesion.actual.fingerprint!==null),
      sides:{radiant:sample(maps.filter(m=>m.side==='radiant')),dire:sample(maps.filter(m=>m.side==='dire'))},
      opponents:[...opponents].map(([opponentId,rows])=>({opponentId,stats:sample(rows)})).sort((a,b)=>(b.stats.nRaw??0)-(a.stats.nRaw??0)),cohesion,strength}};
  }
  const a=team(input.teamAId,input.lineupA),b=team(input.teamBId,input.lineupB),knownFives=a.report.cohesion.actual.fingerprint!==null&&b.report.cohesion.actual.fingerprint!==null;
  const h2h=a.maps.filter(m=>m.opponentId===input.teamBId).map(m=>{
    const fives=actualFives.get(m.matchId)!,teamAPlayerIds=fives[m.side],teamBPlayerIds=fives[m.side==='radiant'?'dire':'radiant'];
    const af=fingerprint(teamAPlayerIds),bf=fingerprint(teamBPlayerIds);
    return {...m,teamASide:m.side,teamAPlayerIds,teamBPlayerIds,matchesSelectedFives:!knownFives||af===null||bf===null?null:
      af===a.report.cohesion.actual.fingerprint&&bf===b.report.cohesion.actual.fingerprint};
  });
  const coverage={candidates:candidates.length,unknownPro:candidates.filter(m=>m.isPro===null).length,nonPro:candidates.filter(m=>m.isPro===false).length,
    conflict:candidates.filter(m=>m.conflict).length,unfinished:candidates.filter(m=>!m.completed).length,
    unattributedOrganizationMaps:candidates.filter(m=>m.radiantTeamId===null||m.direTeamId===null).length,
    h2hIncompleteFives:h2h.filter(m=>fingerprint(m.teamAPlayerIds)===null||fingerprint(m.teamBPlayerIds)===null).length,lineupHistoryFilterExcluded:candidates.length-rosterCandidates.length};
  return CompareReportSchema.parse({status:a.maps.length||b.maps.length?'ready':'insufficient_data',scope:'retrospective_descriptive',policyVersion:'team-compare-v1',
    input,fromAt:input.fromAt,cutoffAt:input.cutoffAt,snapshotAt,source:'normalized_local_maps',identityRevision,registryRevision:registry.revision,currentPatchId:currentPatch.value,
    recentLimit:20,model:null,predictionEligibility:'not_assessed',teamAWinProbability:null,teamA:a.report,teamB:b.report,
    h2h:{organizations:sample(h2h),selectedFives:sample(h2h.filter(m=>m.matchesSelectedFives===true),knownFives),maps:h2h.slice(0,100),displayedLimit:100,omittedMaps:Math.max(0,h2h.length-100)},coverage,
    warnings:['RETROSPECTIVE_NOT_HISTORICAL_FEATURES','ORGANIZATION_NOT_CURRENT_FIVE','MANUAL_LINEUPS_NOT_CONFIRMED_PARTICIPATION','LOCAL_HISTORY_NOT_EXHAUSTIVE',
      ...(currentPatch.value===null?['CURRENT_PATCH_UNKNOWN']:[]),...(coverage.h2hIncompleteFives?['H2H_LINEUPS_INCOMPLETE']:[]),
      ...(input.patchId||input.leagueId?['STRENGTH_HAS_SEPARATE_UNFILTERED_LAST20_COHORT']:[])]});
}
