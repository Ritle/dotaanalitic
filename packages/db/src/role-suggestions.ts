import {RoleSuggestionReportSchema,type RoleSuggestionReport,type StoredAccountEvidence} from '@dota/contracts';
import {resolveIdentity} from './identity.js';
import {canonicalContextJson} from './temporal.js';
import type {ProMapCandidate} from './pro-maps.js';

export type RoleLaneRow={playerSlot:number;accountId:string;laneRole:number|null;gpm:number|null};
export type RoleLaneEvidence={matchId:string;receiptId:string;fetchedAt:string;players:RoleLaneRow[]};
/** An intentionally conservative 2-1-2 heuristic; never a confirmed professional position. */
export function estimateLaneRoles(players:readonly RoleLaneRow[],base:0|128):Map<number,number>{
  const side=players.filter(p=>p.playerSlot>=base&&p.playerSlot<=base+4);
  if(side.length!==5||new Set(side.map(p=>p.playerSlot)).size!==5||new Set(side.map(p=>p.accountId)).size!==5)return new Map();
  const safe=side.filter(p=>p.laneRole===1),mid=side.filter(p=>p.laneRole===2),off=side.filter(p=>p.laneRole===3);
  if(safe.length!==2||mid.length!==1||off.length!==2)return new Map();
  const result=new Map<number,number>([[mid[0]!.playerSlot,2]]);
  for(const [pair,core,support] of [[safe,1,5],[off,3,4]] as const){
    const [a,b]=pair;
    if(a!.gpm===null||b!.gpm===null||a!.gpm!<=0||b!.gpm!<=0||a!.gpm===b!.gpm)continue;
    result.set(a!.playerSlot,a!.gpm!>b!.gpm!?core:support);result.set(b!.playerSlot,a!.gpm!>b!.gpm!?support:core);
  }
  return result;
}

/** Current reconstruction only. No estimate is written into historical role facts or Elo features. */
export function buildRoleSuggestions(playerIds:readonly string[],cutoffAt:string,snapshotAt:string,
  candidates:readonly ProMapCandidate[],accounts:readonly StoredAccountEvidence[],lanes:readonly RoleLaneEvidence[]):RoleSuggestionReport{
  const fromAt=new Date(Date.parse(cutoffAt)-90*86400000).toISOString();
  const proofs=accounts.filter(e=>e.fetchedAt<=snapshotAt&&(e.eventAt===null||e.eventAt<=snapshotAt)&&(e.knownAt===null||e.knownAt<=snapshotAt));
  const resolved=new Map([...new Set(proofs.map(e=>e.externalAccountId))].map(id=>[id,resolveIdentity(proofs,id,null)]));
  const seen=new Set<string>();
  const maps=candidates.filter(m=>{
    if(seen.has(m.matchId))throw new Error('duplicate_role_map');seen.add(m.matchId);
    return m.isPro===true&&!m.conflict&&m.completed&&m.radiantWin!==null&&m.durationSeconds!==null&&m.durationSeconds>0&&
      m.startedAt>=fromAt&&m.startedAt<cutoffAt&&Date.parse(m.startedAt)+m.durationSeconds*1000<=Date.parse(cutoffAt);
  }).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||(BigInt(a.matchId)>BigInt(b.matchId)?-1:1));
  const players=playerIds.map(playerId=>{
    const evidence:RoleSuggestionReport['players'][number]['evidence']=[];
    let nRaw=0;
    for(const m of maps){
      const members=m.players.map(p=>({...p,identity:p.sourceAccountId===null?null:resolved.get(p.sourceAccountId)}));
      const target=members.filter(p=>p.identity?.playerId===playerId);
      const ids=members.flatMap(p=>p.identity?.playerId??[]);
      if(target.length!==1||new Set(ids).size!==ids.length)continue;
      const p=target[0]!,base=p.playerSlot>=128?128:0;
      if(![0,1,2,3,4,128,129,130,131,132].includes(p.playerSlot))continue;
      if(nRaw>=20)break;nRaw++;
      const facts=m.observations.filter(r=>r.fact.field==='roles'&&r.evidenceRef!==null&&r.fetchedAt<=snapshotAt&&
        (r.eventAt===null||r.eventAt<=snapshotAt)&&(r.knownAt===null||r.knownAt<=snapshotAt)&&
        ['verified_asof','retrospective_fact'].includes(r.availability)&&['accepted','conflict'].includes(r.reviewState));
      // Explicit conflicts veto heuristic fallback for this map.
      if(facts.some(r=>r.reviewState==='conflict')||new Set(facts.map(r=>canonicalContextJson(r.fact))).size>1)continue;
      const fact=facts[0]?.fact,roles=fact?.field==='roles'?fact.value??[]:[];
      const role=roles.find(r=>r.playerSlot===p.playerSlot&&r.playerId===playerId&&r.rolePos!==null&&r.basis==='confirmed'&&
        (r.confidence===null||r.confidence===1));
      if(role&&roles.filter(r=>r.rolePos===role.rolePos&&(r.playerSlot>=128)===(base===128)).length===1){
        evidence.push({matchId:m.matchId,startedAt:m.startedAt,rolePos:role.rolePos!,basis:'confirmed_history',
          proofIds:facts.map(r=>r.id),identityProofIds:p.identity!.observationIds,fetchedAt:facts.map(r=>r.fetchedAt).sort().at(-1)!});continue;
      }
      if(roles.some(r=>r.playerSlot===p.playerSlot&&r.basis==='confirmed'))continue;
      const sources=lanes.filter(r=>r.matchId===m.matchId&&r.fetchedAt<=snapshotAt);
      const values=sources.map(r=>{
        const side=members.filter(a=>a.playerSlot>=base&&a.playerSlot<=base+4);
        if(side.length!==5||side.some(a=>a.identity?.playerId==null))return null;
        const raw=r.players.filter(a=>a.playerSlot>=base&&a.playerSlot<=base+4);
        if(raw.some(a=>!side.some(s=>s.playerSlot===a.playerSlot&&s.sourceAccountId===a.accountId&&s.gpm===a.gpm)))return null;
        return estimateLaneRoles(raw,base).get(p.playerSlot)??null;
      });
      if(values.length===0||values.some(v=>v===null)||new Set(values).size!==1)continue;
      evidence.push({matchId:m.matchId,startedAt:m.startedAt,rolePos:values[0]!,basis:'lane_gpm_estimate',
        proofIds:sources.map(r=>'receipt:'+r.receiptId),identityProofIds:p.identity!.observationIds,
        fetchedAt:sources.map(r=>r.fetchedAt).sort().at(-1)!});
    }
    const distribution=Array.from({length:5},(_,i)=>({rolePos:i+1,maps:evidence.filter(e=>e.rolePos===i+1).length}));
    const topCount=Math.max(0,...distribution.map(d=>d.maps)),top=distribution.filter(d=>d.maps===topCount);
    // A strict majority avoids arbitrary tie-breaking and forced assignment of a leftover role.
    const suggestedRole=topCount>evidence.length/2&&top.length===1?top[0]!.rolePos:null;
    const reasons=[];
    if(!nRaw)reasons.push('NO_ELIGIBLE_PRO_HISTORY');
    if(evidence.length<nRaw)reasons.push('ROLE_COVERAGE_PARTIAL');
    if(evidence.length<3)reasons.push('SMALL_SAMPLE');
    if(suggestedRole===null&&evidence.length)reasons.push('AMBIGUOUS_ROLE');
    if(evidence.some(e=>e.basis==='lane_gpm_estimate'))reasons.push('UNVALIDATED_HEURISTIC');
    return {playerId,suggestedRole,basis:suggestedRole===null?'unknown' as const:evidence.every(e=>e.basis==='confirmed_history')?'confirmed_history' as const:'lane_gpm_estimate' as const,
      nRaw,nUsed:evidence.length,topCount,lastMatchAt:evidence[0]?.startedAt??null,reasons,distribution,evidence};
  });
  const suggested=players.flatMap(p=>p.suggestedRole??[]),warnings=['SUGGESTION_NOT_CONFIRMED_ROLE','CURRENT_RECONSTRUCTION_NOT_HISTORICAL_AVAILABILITY','LOCAL_HISTORY_NOT_EXHAUSTIVE','NOT_USED_BY_V1_ELO'];
  if(new Set(suggested).size!==suggested.length)warnings.push('DUPLICATE_SUGGESTED_ROLES');
  return RoleSuggestionReportSchema.parse({status:suggested.length===players.length&&new Set(suggested).size===suggested.length?'ready':suggested.length?'partial':'unavailable',
    scope:'current_descriptive_suggestion',policyVersion:'role-suggestion-lane-gpm-v1',snapshotAt,cutoffAt,fromAt,
    maxMapsPerPlayer:20,windowDays:90,source:'normalized_local_pro_maps',model:null,warnings,players});
}
