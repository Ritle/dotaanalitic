import {sampleEvidence,shrinkObservedRate} from '@dota/analytics';
import {ReferencePoolSchema,type Smoothing,type GameRegistry,type StoredAccountEvidence,type PlayerHeroQuery} from '@dota/contracts';
import type {ProMapCandidate} from './pro-maps.js';
import {resolveIdentity} from './identity.js';
import {resolvePatchAt} from './game-context.js';
import {canonicalContextJson} from './temporal.js';
export type ReferenceInput={candidates:readonly ProMapCandidate[];evidence:readonly StoredAccountEvidence[]}|null;
type ReferenceObservation={matchId:string;heroId:string;rolePos:number|null;patchId:string|null;seriesId:string|null;won:boolean};
export function buildReferencePool(beforeAt:string,snapshotAt:string,input:ReferenceInput,registry:GameRegistry,query:PlayerHeroQuery,reason='REFERENCE_NOT_LOADED'){
  const coverage={candidates:input?.candidates.length??0,eligibleMaps:0,heroObservations:0,confirmedRoles:0,knownPatches:0,verifiedSeries:0};
  const observations:ReferenceObservation[]=[],provenance:ReturnType<typeof ReferencePoolSchema.parse>['provenance']=[];
  const byAccount=new Map<string,StoredAccountEvidence[]>();
  for(const p of input?.evidence??[])if(p.fetchedAt<=snapshotAt&&(p.knownAt===null||p.knownAt<=snapshotAt)&&(p.eventAt===null||p.eventAt<=snapshotAt)){
    const group=byAccount.get(p.externalAccountId)??[];group.push(p);byAccount.set(p.externalAccountId,group);
  }
  const identities=new Map([...byAccount].map(([account,proofs])=>[account,resolveIdentity(proofs,account,null)])),seen=new Set<string>();
  for(const m of input?.candidates??[]){
    if(seen.has(m.matchId))throw new Error('duplicate_reference_map');seen.add(m.matchId);
    if(m.startedAt>=beforeAt)throw new Error('reference_overlaps_observation_window');
    if(m.isPro!==true||m.conflict||!m.completed||m.radiantWin===null||m.durationSeconds===null||m.durationSeconds<=0)continue;
    coverage.eligibleMaps++;
    const players=m.players.map(p=>({...p,identity:p.sourceAccountId===null?null:identities.get(p.sourceAccountId)??null}));
    const facts=m.observations.filter(p=>p.matchId===m.matchId&&p.fetchedAt<=snapshotAt&&(p.knownAt===null||p.knownAt<=snapshotAt)&&
      (p.eventAt===null||p.eventAt<=snapshotAt)&&p.evidenceRef!==null&&['verified_asof','retrospective_fact'].includes(p.availability)&&['accepted','conflict'].includes(p.reviewState));
    const roleFacts=facts.filter(p=>p.fact.field==='roles'),seriesFacts=facts.filter(p=>p.fact.field==='series_id');
    const roleConflict=roleFacts.some(p=>p.reviewState==='conflict')||new Set(roleFacts.map(p=>canonicalContextJson(p.fact))).size>1;
    const rf=roleConflict?null:roleFacts[0]?.fact;
    const roles=(rf?.field==='roles'?rf.value??[]:[]).filter(r=>r.playerId!==null&&r.rolePos!==null&&r.basis==='confirmed'&&(r.confidence===null||r.confidence===1)&&
      players.some(p=>p.playerSlot===r.playerSlot&&p.identity?.playerId===r.playerId));
    const seriesId=m.seriesId!==null&&seriesFacts.length>0&&seriesFacts.every(p=>p.reviewState==='accepted'&&p.fact.value===m.seriesId)?m.seriesId:null;
    const patch=resolvePatchAt(registry.patches.filter(p=>p.fetchedAt<=snapshotAt),m.startedAt,snapshotAt);
    for(const p of players){
      if(!((p.playerSlot>=0&&p.playerSlot<=4)||(p.playerSlot>=128&&p.playerSlot<=132)))continue;
      if(p.heroId==null||!Number.isInteger(p.heroId)||p.heroId<=0||p.heroId>2147483647||players.filter(other=>other.heroId===p.heroId).length!==1)continue;
      const side=p.playerSlot<128?'radiant':'dire',opponent=side==='radiant'?m.direTeamId:m.radiantTeamId;
      if(query.side&&query.side!==side||query.opponentId&&query.opponentId!==opponent||query.leagueId&&query.leagueId!==m.leagueId)continue;
      const role=roles.find(r=>r.playerSlot===p.playerSlot&&r.playerId===p.identity?.playerId);
      const rolePos=role&&players.filter(other=>other.identity?.playerId===p.identity?.playerId).length===1&&
        roles.filter(r=>(r.playerSlot<128)===(p.playerSlot<128)&&r.rolePos===role.rolePos).length===1?role.rolePos:null;
      if(query.rolePos&&query.rolePos!==rolePos)continue;
      observations.push({matchId:m.matchId,heroId:String(p.heroId),rolePos,patchId:patch.value,seriesId,won:side==='radiant'?m.radiantWin:!m.radiantWin});
    }
    provenance.push({matchId:m.matchId,startedAt:m.startedAt,dataRevision:m.dataRevision,source:m.source,syncedAt:m.syncedAt,sourceFetchedAt:m.sourceFetchedAt,
      identityProofIds:[...new Set(players.flatMap(p=>p.identity?.observationIds??[]))].sort(),roleProofIds:roleFacts.map(p=>p.id),patchProofIds:patch.evidenceIds,seriesProofIds:seriesFacts.map(p=>p.id)});
  }
  coverage.heroObservations=observations.length;coverage.confirmedRoles=observations.filter(o=>o.rolePos!==null).length;
  coverage.knownPatches=observations.filter(o=>o.patchId!==null).length;coverage.verifiedSeries=observations.filter(o=>o.seriesId!==null).length;
  const grouped=(patch:boolean)=>{const groups=new Map<string,ReferenceObservation[]>();for(const o of observations){const key=`${o.heroId}:${o.rolePos}:${patch?o.patchId:'all'}`,g=groups.get(key)??[];g.push(o);groups.set(key,g);}return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([,rows])=>{
    const wins=rows.filter(r=>r.won).length;return {heroId:rows[0]!.heroId,rolePos:rows[0]!.rolePos,...(patch?{patchId:rows[0]!.patchId}:{}),nRaw:rows.length,wins,winRate:wins/rows.length,sampleEvidence:sampleEvidence(rows.length)};
  });};
  const report=ReferencePoolSchema.parse({status:input?'ready':'unavailable',reason:input?null:reason,beforeAt,policyVersion:'earlier-reference-beta-v1',scope:'retrospective_reference',
    coverage:input?coverage:{candidates:null,eligibleMaps:null,heroObservations:null,confirmedRoles:null,knownPatches:null,verifiedSeries:null},buckets:grouped(true),globalBuckets:grouped(false),provenance:provenance.sort((a,b)=>BigInt(a.matchId)<BigInt(b.matchId)?-1:1)});
  return {report,observations};
}
export function referenceSmoothing(nRaw:number,wins:number,heroId:string|null,rolePos:number|null,patchId:string|null,
  targetSeries:readonly (string|null)[],reference:ReturnType<typeof buildReferencePool>):Smoothing{
  const common={policyVersion:'earlier-reference-beta-v1' as const,validation:'unvalidated_descriptive' as const};
  const unavailable=(reason:string):Smoothing=>({...common,status:'unavailable',smoothedObservedRate:null,priorOnly:false,prior:null,reasons:[reason]});
  if(reference.report.status!=='ready')return unavailable(reference.report.reason??'REFERENCE_UNAVAILABLE');
  if(heroId===null||rolePos===null||patchId===null)return unavailable('CONTEXT_NOT_SPECIFIC');
  if(targetSeries.some(id=>id===null))return unavailable('TARGET_SERIES_UNVERIFIED');
  const excluded=new Set(targetSeries),rows=reference.observations.filter(o=>o.heroId===heroId&&o.rolePos===rolePos&&o.patchId===patchId&&o.seriesId!==null&&!excluded.has(o.seriesId));
  const referenceN=rows.length,referenceWins=rows.filter(o=>o.won).length;
  if(referenceN===0)return unavailable('NO_COMPARABLE_REFERENCE_MAPS');
  if(referenceWins===0||referenceWins===referenceN)return unavailable('REFERENCE_HAS_ONLY_ONE_OUTCOME');
  const result=shrinkObservedRate(nRaw,wins,referenceN,referenceWins);
  return {...common,status:'available',smoothedObservedRate:result.smoothedObservedRate,priorOnly:result.priorOnly,reasons:[],
    prior:{...result.prior,heroId,rolePos,patchId,beforeAt:reference.report.beforeAt,matchIds:rows.map(r=>r.matchId).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1),seriesIds:[...new Set(rows.map(r=>r.seriesId!))].sort()}};
}
