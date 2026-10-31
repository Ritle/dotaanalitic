import {ELO_POLICY,replayElo,type EloMap} from '@dota/analytics';
import {ContextFactSchema,StrengthReportSchema,type StrengthQuery,type StrengthProof,type StoredAccountEvidence} from '@dota/contracts';
import {resolveIdentity} from './identity.js';
import {canonicalContextJson} from './temporal.js';
export type StrengthCandidate={matchId:string;startedAt:string;startedAtUs:string;endedAtUs:string|null;isPro:boolean|null;conflict:boolean;
  radiantWin:boolean|null;radiantTeamId:string|null;direTeamId:string|null;source:string;syncedAt:string;dataRevision:string;
  players:{playerSlot:number;sourceAccountId:string|null}[];proofs:StrengthProof[]};
export type StrengthFilters=StrengthQuery & {fromAt:string;cutoffAt:string};
export function strengthMetadata(organizationId:string,filters:StrengthFilters,snapshotAt:string){return {organizationId,filters,fromAt:filters.fromAt,
  cutoffAt:filters.cutoffAt,snapshotAt,source:'normalized_local_maps' as const,scope:'chronological_retrospective_participation' as const,
  policy:ELO_POLICY,model:null,predictionEligibility:'not_assessed' as const,teamAWinProbability:null};}
export function buildStrengthReport(organizationId:string,query:StrengthFilters,snapshotAt:string,candidates:readonly StrengthCandidate[],evidence:readonly StoredAccountEvidence[],identityRevision:string){
  const cutoff=BigInt(Date.parse(query.cutoffAt))*1000n,snapshot=BigInt(Date.parse(snapshotAt))*1000n;
  const coverage={globalCandidates:candidates.length,unknownPro:0,nonPro:0,conflict:0,unfinished:0,identityUnavailable:0,evidenceUnavailable:0,
    globalReplayMaps:0,updatesApplied:0,pendingUpdates:0,targetMapsBeforeLimit:0,opponentPriorMaps:0};
  const byAccount=new Map<string,StoredAccountEvidence[]>();
  for(const e of evidence)if(e.fetchedAt<=snapshotAt){const group=byAccount.get(e.externalAccountId)??[];group.push(e);byAccount.set(e.externalAccountId,group);}
  const inputs:EloMap[]=[],seen=new Set<string>(),details=new Map<string,{identityProofIds:string[];factProofIds:string[];reasons:string[];lineupKnownBeforeStart:boolean}>();
  let conflictAt:bigint|null=null;
  const raw:StrengthCandidate[]=[];
  for(const m of candidates){
    if(seen.has(m.matchId))throw new Error('duplicate_canonical_map');seen.add(m.matchId);
    const start=BigInt(m.startedAtUs);if(start>=cutoff)throw new Error('candidate_outside_cutoff');
    if(m.isPro!==true){if(m.isPro===null)coverage.unknownPro++;else coverage.nonPro++;continue;}
    if(m.conflict){coverage.conflict++;continue;}
    if(m.endedAtUs===null||BigInt(m.endedAtUs)<=start||BigInt(m.endedAtUs)>cutoff||m.radiantWin===null){coverage.unfinished++;continue;}
    if((m.radiantTeamId===organizationId||m.direTeamId===organizationId)&&m.startedAt>=query.fromAt)raw.push(m);
    const d={identityProofIds:[] as string[],factProofIds:[] as string[],reasons:[] as string[],lineupKnownBeforeStart:false};details.set(m.matchId,d);
    const asOf=new Date(Number(start/1000n)).toISOString();
    const players=m.players.map(p=>({...p,identity:p.sourceAccountId===null?null:resolveIdentity(byAccount.get(p.sourceAccountId)??[],p.sourceAccountId,asOf)}));
    d.identityProofIds=[...new Set(players.flatMap(p=>p.identity?.observationIds??[]))].sort();
    const valid=players.length===10&&new Set(players.map(p=>p.identity?.playerId??null)).size===10&&players.every(p=>p.identity?.playerId!=null)&&
      [0,128].every(base=>Array.from({length:5},(_,i)=>base+i).every(slot=>players.some(p=>p.playerSlot===slot)));
    if(!valid){coverage.identityUnavailable++;d.reasons.push('IDENTITY_NOT_VERIFIED_AT_MAP_START');continue;}
    const lineup=players.map(p=>({playerSlot:p.playerSlot,playerId:p.identity!.playerId!}));
    let available=BigInt(m.endedAtUs),failed=false;
    for(const field of ['pro_classification','radiant_win','context.lineup'] as const){
      const facts=m.proofs.filter(p=>p.field===field&&p.availability==='verified_asof'&&p.knownAtUs!==null&&p.evidenceRef?.trim()&&
        BigInt(p.fetchedAtUs)<=snapshot&&BigInt(p.knownAtUs)<=BigInt(p.fetchedAtUs)&&
        (p.eventAtUs===null||BigInt(p.eventAtUs)<=BigInt(p.fetchedAtUs))&&['accepted','conflict'].includes(p.reviewState));
      const matches=(p:StrengthProof)=>{
        if(field==='radiant_win')return p.value===m.radiantWin&&BigInt(p.knownAtUs!)>=BigInt(m.endedAtUs!);
        if(field==='pro_classification')return p.value!==null&&typeof p.value==='object'&&'value' in p.value&&p.value.value===true;
        const parsed=ContextFactSchema.safeParse({field:'lineup',value:p.value});
        return parsed.success&&canonicalContextJson(parsed.data.value)===canonicalContextJson(lineup);
      };
      const effective=(p:StrengthProof)=>BigInt(p.knownAtUs!)>BigInt(p.eventAtUs??'0')?BigInt(p.knownAtUs!):BigInt(p.eventAtUs??'0');
      facts.sort((a,b)=>effective(a)<effective(b)?-1:effective(a)>effective(b)?1:BigInt(a.id)<BigInt(b.id)?-1:1);
      const first=facts.find(p=>p.reviewState==='accepted'&&matches(p)),bad=facts.find(p=>p.reviewState==='conflict'||!matches(p));
      if(bad){const at=effective(bad);if(at<=cutoff&&(conflictAt===null||at<conflictAt))conflictAt=at;}
      if(!first||bad&&effective(bad)<=effective(first)){failed=true;d.reasons.push('MISSING_OR_CONFLICTING_'+field.toUpperCase().replace('.','_'));continue;}
      const at=effective(first);if(at>available)available=at;
      d.factProofIds.push(...facts.map(p=>p.id));
      if(field==='context.lineup')d.lineupKnownBeforeStart=at<=start&&first.earliestStage!=='post_match';
    }
    if(failed){coverage.evidenceUnavailable++;continue;}
    inputs.push({matchId:m.matchId,startedAtUs:m.startedAtUs,endedAtUs:m.endedAtUs,availableAtUs:String(available),radiantWin:m.radiantWin,
      radiantPlayerIds:lineup.filter(p=>p.playerSlot<128).map(p=>p.playerId),direPlayerIds:lineup.filter(p=>p.playerSlot>=128).map(p=>p.playerId)});
  }
  inputs.sort((a,b)=>BigInt(a.startedAtUs)<BigInt(b.startedAtUs)?-1:BigInt(a.startedAtUs)>BigInt(b.startedAtUs)?1:BigInt(a.matchId)<BigInt(b.matchId)?-1:1);
  const replayCutoff=conflictAt===null?cutoff:conflictAt>0n?conflictAt-1n:0n;
  const replay=replayElo(inputs,String(replayCutoff)),byId=new Map(replay.observations.map(r=>[r.matchId,r]));
  coverage.globalReplayMaps=inputs.length;coverage.updatesApplied=replay.observations.filter(r=>r.updateApplied).length;coverage.pendingUpdates=inputs.length-coverage.updatesApplied;
  raw.sort((a,b)=>BigInt(a.startedAtUs)>BigInt(b.startedAtUs)?-1:BigInt(a.startedAtUs)<BigInt(b.startedAtUs)?1:BigInt(a.matchId)>BigInt(b.matchId)?-1:1);
  coverage.targetMapsBeforeLimit=raw.length;
  const maps=raw.slice(0,query.limit).map(m=>{const row=byId.get(m.matchId),side=m.radiantTeamId===organizationId?'radiant' as const:'dire' as const,
    own=row?.[side],opponent=row?.[side==='radiant'?'dire':'radiant'],d=details.get(m.matchId)!;
    return {matchId:m.matchId,startedAt:m.startedAt,startedAtUs:m.startedAtUs,endedAtUs:m.endedAtUs!,side,won:side==='radiant'?m.radiantWin!:!m.radiantWin,
      opponentId:side==='radiant'?m.direTeamId:m.radiantTeamId,source:m.source,syncedAt:m.syncedAt,dataRevision:m.dataRevision,
      rating:row&&own&&opponent?{ownBefore:own.ratingBefore,opponentBefore:opponent.ratingBefore,change:row.updateApplied?own.ratingDelta:null,
        priorPlayers:own.priorPlayers,opponentPriorPlayers:opponent.priorPlayers,fingerprint:own.fingerprint,opponentFingerprint:opponent.fingerprint,
        availableAtUs:row.availableAtUs,updateApplied:row.updateApplied,lineupKnownBeforeStart:d.lineupKnownBeforeStart}:null,
      identityProofIds:d.identityProofIds,factProofIds:d.factProofIds,reasons:[...d.reasons,...(row&&!row.updateApplied?['RESULT_NOT_AVAILABLE_AT_CUTOFF']:[]),
        ...(conflictAt!==null&&BigInt(m.startedAtUs)>=conflictAt?['RATING_STOPPED_AT_PROOF_CONFLICT']:[])]};});
  const rated=maps.flatMap(m=>m.rating?.updateApplied?[m.rating]:[]),wins=maps.filter(m=>m.won).length;
  coverage.opponentPriorMaps=rated.filter(r=>r.opponentPriorPlayers>0).length;
  const latest=conflictAt===null&&maps[0]?.rating?.updateApplied?maps[0].rating:null,finalPlayers=new Map(replay.players.map(p=>[p.playerId,p.rating]));
  const current=latest?latest.fingerprint.split(':').map(id=>finalPlayers.get(id)!):null;
  const avg=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
  return StrengthReportSchema.parse({...strengthMetadata(organizationId,query,snapshotAt),status:rated.length?'ready':'insufficient_data',identityRevision,replayStoppedAtUs:conflictAt===null?null:String(conflictAt),
    summary:{nRaw:maps.length,wins,winRate:maps.length?wins/maps.length:null,ratedMaps:rated.length,
      meanOpponentRatingBefore:avg(rated.map(r=>r.opponentBefore)),meanRatingChange:avg(rated.map(r=>r.change!)),lastObservedFiveRating:current?avg(current):null,
      lastObservedFiveFingerprint:latest?.fingerprint??null,dataUpdatedAt:maps.map(m=>m.syncedAt).sort().at(-1)??null},coverage,maps,
    replayManifest:inputs.map(m=>({matchId:m.matchId,startedAtUs:m.startedAtUs,availableAtUs:m.availableAtUs,dataRevision:candidates.find(c=>c.matchId===m.matchId)!.dataRevision,
      identityProofIds:details.get(m.matchId)!.identityProofIds,factProofIds:details.get(m.matchId)!.factProofIds})),
    warnings:['UNVALIDATED_RATING_NOT_FORECAST','RECONSTRUCTED_PARTICIPATION_NOT_PREKNOWN_LINEUP','LOCAL_HISTORY_NOT_EXHAUSTIVE',
      ...(coverage.identityUnavailable?['HISTORICAL_IDENTITY_GAPS']:[]),...(coverage.evidenceUnavailable?['HISTORICAL_AVAILABILITY_GAPS']:[]),
      ...(coverage.pendingUpdates?['RESULTS_PENDING_AT_CUTOFF']:[]),...(coverage.opponentPriorMaps?['OPPONENT_PRIOR_PLAYERS']:[]),...(conflictAt!==null?['RATING_STOPPED_AT_PROOF_CONFLICT']:[])]});
}
