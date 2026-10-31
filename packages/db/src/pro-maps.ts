import {ContextObservationSchema,ProMapReportSchema,type GameRegistry,type ProMapQuery,type ProMapItem,type StoredAccountEvidence,type StoredContextObservation} from '@dota/contracts';
import {resolveIdentity} from './identity.js';
import {resolvePatchAt} from './game-context.js';
import {canonicalContextJson} from './temporal.js';

export type ProMapCandidate={matchId:string;startedAt:string;isPro:boolean|null;conflict:boolean;completed:boolean;
  radiantWin:boolean|null;durationSeconds:number|null;radiantTeamId:string|null;direTeamId:string|null;
  leagueId:string|null;seriesId:string|null;source:string;syncedAt:string;sourceFetchedAt:string|null;dataRevision:string;
  players:{playerSlot:number;sourceAccountId:string|null}[];observations:StoredContextObservation[]};

/** Current retrospective display only; NEVER used as historical training/inference feature reader. */
export function selectProMaps(kind:'teams'|'players',id:string,query:ProMapQuery & {cutoffAt:string},snapshotAt:string,
  candidates:readonly ProMapCandidate[],registry:GameRegistry,evidence:readonly StoredAccountEvidence[],identityRevision:string,unattributed:number) {
  const coverage={candidates:candidates.length,unknownPro:0,nonPro:0,conflict:0,unfinished:0,identityUnresolved:0,filterMismatch:0,
    eligibleBeforeLimit:0,knownPatch:0,completeCanonicalRosters:0,knownSeries:0,knownOpponent:0,confirmedTargetRole:0,lateFetchedMaps:0,
    unattributedOrganizationMapsInWindow:unattributed};
  const eligible:ProMapItem[]=[];
  const accounts=new Map<string,ReturnType<typeof resolveIdentity>>();
  const currentEvidence=evidence.filter(p=>p.fetchedAt<=snapshotAt && (p.eventAt===null||p.eventAt<=snapshotAt) && (p.knownAt===null||p.knownAt<=snapshotAt));
  const byAccount=new Map<string,StoredAccountEvidence[]>();
  for(const proof of currentEvidence){const group=byAccount.get(proof.externalAccountId)??[];group.push(proof);byAccount.set(proof.externalAccountId,group);}
  const patchEvidence=registry.patches.filter(p=>p.fetchedAt<=snapshotAt);
  const seen=new Set<string>();
  for(const map of candidates) {
    if(seen.has(map.matchId))throw new Error('duplicate_canonical_map');seen.add(map.matchId);
    if(map.startedAt>=query.cutoffAt || query.fromAt && map.startedAt<query.fromAt)throw new Error('candidate_outside_window');
    if(map.isPro!==true){if(map.isPro===null)coverage.unknownPro++;else coverage.nonPro++;continue;}
    if(map.conflict){coverage.conflict++;continue;}
    if(!map.completed||map.radiantWin===null||map.durationSeconds===null||map.durationSeconds<=0){coverage.unfinished++;continue;}
    const players=map.players.map(p=>{
      if(p.sourceAccountId!==null && !accounts.has(p.sourceAccountId))accounts.set(p.sourceAccountId,resolveIdentity(byAccount.get(p.sourceAccountId)??[],p.sourceAccountId,null));
      return {...p,identity:p.sourceAccountId===null?null:accounts.get(p.sourceAccountId)??null};
    });
    const targetPlayer=kind==='players'?id:query.playerId;
    const target=targetPlayer?players.filter(p=>p.identity?.playerId===targetPlayer):[];
    // A duplicate canonical identity on a map is never two player observations.
    const targetValid=!targetPlayer||target.length===1;
    if(!targetValid){coverage.identityUnresolved++;continue;}
    const side=kind==='teams'?(map.radiantTeamId===id?'radiant':'dire'):(target[0]!.playerSlot<128?'radiant':'dire');
    if(kind==='teams' && map.radiantTeamId!==id && map.direTeamId!==id)throw new Error('candidate_wrong_organization');
    if(targetPlayer && (target[0]!.playerSlot<128?'radiant':'dire')!==side){coverage.filterMismatch++;continue;}
    const org=side==='radiant'?map.radiantTeamId:map.direTeamId,opponent=side==='radiant'?map.direTeamId:map.radiantTeamId;
    const knownIds=players.map(p=>p.identity?.playerId??null);
    const complete=players.length===10 && knownIds.every(p=>p!==null) && new Set(knownIds).size===10 &&
      [0,128].every(base=>Array.from({length:5},(_,i)=>base+i).every(slot=>players.some(p=>p.playerSlot===slot)));
    const facts=map.observations.filter(row=>row.matchId===map.matchId && row.fetchedAt<=snapshotAt &&
      (row.eventAt===null||row.eventAt<=snapshotAt) && (row.knownAt===null||row.knownAt<=snapshotAt) && row.evidenceRef!==null &&
      ['verified_asof','retrospective_fact'].includes(row.availability) && ['accepted','conflict'].includes(row.reviewState))
      .map(({id:proofId,recordedAt:_recordedAt,...row})=>({id:proofId,...ContextObservationSchema.parse(row)}));
    const rows=facts.filter(r=>r.fact.field==='roles');
    const seriesFacts=facts.filter(r=>r.fact.field==='series_id');
    const seriesConflict=seriesFacts.some(r=>r.reviewState==='conflict' || r.fact.value!==map.seriesId) || new Set(seriesFacts.map(r=>canonicalContextJson(r.fact))).size>1;
    const seriesStatus=seriesConflict?'conflict':map.seriesId!==null && seriesFacts.length>0?'verified':'unknown';
    const roleConflict=rows.some(r=>r.reviewState==='conflict')||new Set(rows.map(r=>canonicalContextJson(r.fact))).size>1;
    const roleFact=roleConflict?null:rows[0]?.fact;
    const roles=roleFact?.field==='roles'?roleFact.value??[]:[];
    const confirmed=roles.filter(r=>r.playerId!==null && r.basis==='confirmed' && (r.confidence===null||r.confidence===1) && r.rolePos!==null &&
      players.some(p=>p.playerSlot===r.playerSlot && p.identity?.playerId===r.playerId));
    const role=targetPlayer?confirmed.find(r=>r.playerId===targetPlayer):undefined;
    const rolePos=role && confirmed.filter(r=>(r.playerSlot<128)===(role.playerSlot<128) && r.rolePos===role.rolePos).length===1?role.rolePos:null;
    const patch=resolvePatchAt(patchEvidence,map.startedAt,snapshotAt);
    if(query.side && side!==query.side || query.opponentId && opponent!==query.opponentId || query.leagueId && map.leagueId!==query.leagueId ||
      query.patchId && patch.value!==query.patchId || query.rolePos && rolePos!==query.rolePos){coverage.filterMismatch++;continue;}
    const warnings:string[]=[];
    if(!complete)warnings.push('INCOMPLETE_CANONICAL_ROSTER');if(!opponent)warnings.push('OPPONENT_UNKNOWN');
    if(seriesStatus!=='verified')warnings.push(seriesStatus==='conflict'?'SERIES_CONFLICT':'SERIES_UNKNOWN');if(!patch.value)warnings.push(patch.reason??'PATCH_UNKNOWN');
    if(targetPlayer && rolePos===null)warnings.push('ROLE_UNVERIFIED');
    if(map.sourceFetchedAt===null)warnings.push('SOURCE_FETCH_UNKNOWN');
    if(map.sourceFetchedAt!==null && map.sourceFetchedAt>query.cutoffAt)warnings.push('SOURCE_FETCHED_AFTER_CUTOFF');
    eligible.push({matchId:map.matchId,startedAt:map.startedAt,side,won:side==='radiant'?map.radiantWin:!map.radiantWin,
      durationSeconds:map.durationSeconds,organizationId:org,opponentId:opponent,leagueId:map.leagueId,seriesId:map.seriesId,
      patchId:patch.value,seriesStatus,rolePos:rolePos??null,completeCanonicalRoster:complete,source:map.source,syncedAt:map.syncedAt,
      sourceFetchedAt:map.sourceFetchedAt,dataRevision:map.dataRevision,identityProofIds:[...new Set(players.flatMap(p=>p.identity?.observationIds??[]))].sort(),
      roleProofIds:rolePos!==null?rows.map(r=>r.id):[],patchProofIds:patch.evidenceIds,seriesProofIds:seriesFacts.map(r=>r.id),warnings});
  }
  eligible.sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||(BigInt(a.matchId)>BigInt(b.matchId)?-1:1));
  coverage.eligibleBeforeLimit=eligible.length;
  const maps=eligible.slice(0,query.limit),nRaw=maps.length,wins=maps.filter(m=>m.won).length;
  const distribution=new Map<string|null,number>();
  for(const map of maps){
    if(map.patchId!==null)coverage.knownPatch++;if(map.completeCanonicalRoster)coverage.completeCanonicalRosters++;
    if(map.seriesStatus==='verified')coverage.knownSeries++;if(map.opponentId!==null)coverage.knownOpponent++;
    if(map.rolePos!==null)coverage.confirmedTargetRole++;if(map.warnings.includes('SOURCE_FETCHED_AFTER_CUTOFF'))coverage.lateFetchedMaps++;
    distribution.set(map.patchId,(distribution.get(map.patchId)??0)+1);
  }
  const warnings=[...new Set(['RETROSPECTIVE_NOT_HISTORICAL_FEATURES',...(kind==='teams'?['ORGANIZATION_NOT_CURRENT_FIVE']:[]),
    ...maps.flatMap(m=>m.warnings),...(nRaw===0?['NO_ELIGIBLE_PRO_MAPS']:[])])].sort();
  return ProMapReportSchema.parse({status:nRaw?'ready':'insufficient_data',scope:'retrospective_descriptive',policyVersion:'pro-map-display-v1',
    entityType:kind==='teams'?'organization':'canonical_player',entityId:id,filters:query,snapshotAt,computedAt:snapshotAt,
    source:'normalized_local_maps',identityRevision,registryRevision:registry.revision,model:null,predictionEligibility:'not_assessed',
    summary:{nRaw,wins,losses:nRaw-wins,winRate:nRaw?wins/nRaw:null,meanDurationSeconds:nRaw?maps.reduce((n,m)=>n+m.durationSeconds,0)/nRaw:null,
      dataUpdatedAt:maps.length?maps.map(m=>m.syncedAt).sort().at(-1):null},coverage,
    patchDistribution:[...distribution].map(([patchId,maps])=>({patchId,maps})),maps,warnings});
}
