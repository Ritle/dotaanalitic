import {createHash} from 'node:crypto';
import {pairObservations,sampleEvidence,shrinkObservedRate,weightedSample} from '@dota/analytics';
import {HeroMatchupReportSchema,SampleEvidenceSchema,type HeroMatchupReport,type HeroMatchupQuery,type HeroPairStat,type ScenarioSnapshot} from '@dota/contracts';
import type {ProMapCandidate} from './pro-maps.js';
import {resolvePatchAt} from './game-context.js';
import {resolveDraftHistoryWeights,type PatchMetaRegistry} from './patch-history.js';
import {canonicalContextJson} from './temporal.js';
type Manifest=HeroMatchupReport['provenance'][number];
type Filter={fromAt?:string;cutoffAt:string;patchId:string|null;leagueId?:string};
/** Retrospective hero-only evidence. Unknown identities/other slots do not invalidate a known pair. */
export function preparePairMaps(candidates:readonly ProMapCandidate[],filter:Filter,snapshotAt:string,registry:PatchMetaRegistry){
  const coverage={candidates:candidates.length,unknownPro:0,nonPro:0,conflict:0,unfinished:0,outsideWindow:0,filterMismatch:0,eligibleMaps:0,
    partialHeroMaps:0,invalidHeroRows:0,unknownPatchMaps:0,unverifiedSeriesMaps:0,lateFetchedMaps:0};
  const maps:Manifest[]=[],seen=new Set<string>();
  for(const m of candidates){
    if(seen.has(m.matchId))throw new Error('duplicate_pair_map');seen.add(m.matchId);
    if(m.startedAt>=filter.cutoffAt||filter.fromAt&&m.startedAt<filter.fromAt){coverage.outsideWindow++;continue;}
    if(m.isPro===null){coverage.unknownPro++;continue;}if(m.isPro!==true){coverage.nonPro++;continue;}if(m.conflict){coverage.conflict++;continue;}
    if(!m.completed||m.radiantWin===null||m.durationSeconds===null||m.durationSeconds<=0||Date.parse(m.startedAt)+m.durationSeconds*1000>Date.parse(filter.cutoffAt)){coverage.unfinished++;continue;}
    const patch=resolvePatchAt(registry.patches.filter(p=>p.fetchedAt<=snapshotAt),m.startedAt,snapshotAt);
    if(patch.value===null)coverage.unknownPatchMaps++;
    if(filter.patchId!==null&&filter.patchId!==patch.value||filter.leagueId&&filter.leagueId!==m.leagueId){coverage.filterMismatch++;continue;}
    const valid=m.players.filter(p=>Number.isInteger(p.playerSlot)&&((p.playerSlot>=0&&p.playerSlot<=4)||(p.playerSlot>=128&&p.playerSlot<=132))&&
      p.heroId!=null&&Number.isInteger(p.heroId)&&p.heroId>0&&p.heroId<=2147483647&&m.players.filter(o=>o.playerSlot===p.playerSlot).length===1&&m.players.filter(o=>o.heroId===p.heroId).length===1);
    const heroes=valid.map(p=>({heroId:p.heroId!,side:p.playerSlot<128?'radiant' as const:'dire' as const})).sort((a,b)=>a.heroId-b.heroId);
    coverage.invalidHeroRows+=m.players.length-valid.length;if(heroes.length<10)coverage.partialHeroMaps++;
    const facts=m.observations.filter(p=>p.matchId===m.matchId&&p.fact.field==='series_id'&&p.evidenceRef!==null&&p.fetchedAt<=snapshotAt&&
      (p.knownAt===null||p.knownAt<=snapshotAt)&&(p.eventAt===null||p.eventAt<=snapshotAt)&&['accepted','conflict'].includes(p.reviewState)&&['verified_asof','retrospective_fact'].includes(p.availability));
    const seriesId=m.seriesId!==null&&facts.length>0&&facts.every(p=>p.reviewState==='accepted'&&p.fact.value===m.seriesId)?m.seriesId:null;
    if(seriesId===null)coverage.unverifiedSeriesMaps++;if(m.sourceFetchedAt!==null&&m.sourceFetchedAt>filter.cutoffAt)coverage.lateFetchedMaps++;
    coverage.eligibleMaps++;maps.push({matchId:m.matchId,startedAt:m.startedAt,radiantWin:m.radiantWin,heroes,patchId:patch.value,seriesId,
      dataRevision:m.dataRevision,source:m.source,syncedAt:m.syncedAt,sourceFetchedAt:m.sourceFetchedAt,patchProofIds:patch.evidenceIds,seriesProofIds:facts.map(p=>p.id)});
  }
  maps.sort((a,b)=>a.startedAt.localeCompare(b.startedAt)||(BigInt(a.matchId)<BigInt(b.matchId)?-1:1));return {maps,coverage};
}
export function buildHeroMatchupReport(snapshot:ScenarioSnapshot,query:HeroMatchupQuery,fromAt:string,cutoffAt:string,snapshotAt:string,
  candidates:readonly ProMapCandidate[],referenceCandidates:readonly ProMapCandidate[]|null,registry:PatchMetaRegistry,heroNames:Map<number,string>):HeroMatchupReport{
  const fetched=(p:{fetchedAt:string})=>p.fetchedAt<=snapshotAt;
  const availableRegistry={...registry,patches:registry.patches.filter(fetched),heroRules:registry.heroRules.filter(fetched),draftRules:registry.draftRules.filter(fetched),
    transitions:registry.transitions.filter(fetched),heroImpacts:registry.heroImpacts.filter(fetched)};
  const registryFingerprint=createHash('sha256').update(canonicalContextJson(availableRegistry)).digest('hex');
  const currentPatchId=resolvePatchAt(registry.patches.filter(p=>p.fetchedAt<=snapshotAt),cutoffAt,snapshotAt).value;
  const effectivePatchId=query.patchScope==='specific'?query.patchId!:query.patchScope==='current'?currentPatchId:null;
  const target=preparePairMaps(candidates,{fromAt,cutoffAt,patchId:effectivePatchId,leagueId:query.leagueId},snapshotAt,registry);
  const reference=referenceCandidates===null?null:preparePairMaps(referenceCandidates,{cutoffAt:fromAt,patchId:effectivePatchId,leagueId:query.leagueId},snapshotAt,registry);
  const excludedSeries=new Set([...target.maps.flatMap(m=>m.seriesId??[]),...(snapshot.input.context.seriesId?[snapshot.input.context.seriesId]:[])]);
  const heroes=(snapshot.input.draft?.assignments??[]).map(h=>({...h,name:heroNames.get(h.heroId)??`Герой #${h.heroId}`})).sort((a,b)=>a.teamSlot.localeCompare(b.teamSlot)||a.rolePos-b.rolePos);
  function stat(kind:'ally'|'enemy',a:typeof heroes[number],b:typeof heroes[number]):HeroPairStat{
    const rows=pairObservations(target.maps,kind,a.heroId,b.heroId),nRaw=rows.length,wins=rows.filter(r=>r.won).length;
    const unavailable=(reason:string):HeroPairStat['smoothing']=>({status:'unavailable',validation:'unvalidated_descriptive',policyVersion:'pair-reference-beta-v1',estimate:null,priorOnly:false,prior:null,reason});
    const patches=new Set(rows.map(r=>r.map.patchId)),specificPatch=effectivePatchId??(patches.size===1?[...patches][0]??null:null);
    let smoothing=unavailable('CONTEXT_NOT_SPECIFIC');
    if(reference===null)smoothing=unavailable('REFERENCE_TOO_LARGE');
    else if(specificPatch!==null){
      if(rows.some(r=>r.map.seriesId===null))smoothing=unavailable('TARGET_SERIES_UNVERIFIED');
      else{
        const pool=pairObservations(reference.maps.filter(m=>m.patchId===specificPatch&&m.seriesId!==null&&!excludedSeries.has(m.seriesId)),kind,a.heroId,b.heroId);
        const priorWins=pool.filter(r=>r.won).length;
        if(!pool.length)smoothing=unavailable('NO_COMPARABLE_REFERENCE_MAPS');
        else if(priorWins===0||priorWins===pool.length)smoothing=unavailable('REFERENCE_HAS_ONLY_ONE_OUTCOME');
        else{const result=shrinkObservedRate(nRaw,wins,pool.length,priorWins);smoothing={status:'available',validation:'unvalidated_descriptive',policyVersion:'pair-reference-beta-v1',estimate:result.smoothedObservedRate,
          priorOnly:result.priorOnly,reason:null,prior:{...result.prior,patchId:specificPatch,beforeAt:fromAt,matchIds:pool.map(r=>r.map.matchId),seriesIds:[...new Set(pool.map(r=>r.map.seriesId!))].sort()}};}
      }
    }
    let weighted:HeroPairStat['weighted']={status:'disabled',validation:'unvalidated_candidate',rate:null,nEff:null,nKnown:0,nPositive:0,nMissing:0,targetPatchId:null,patchColdStart:null,cacheKey:null,reasons:['NO_EXPLICIT_POLICY'],maps:[]};
    if(query.weights){
      const w=resolveDraftHistoryWeights({cutoffAt,feature:'draft_hero',leagueId:snapshot.input.context.leagueId??null,heroIds:[a.heroId,b.heroId],maps:rows.map(r=>({matchId:r.map.matchId,startedAt:r.map.startedAt})),policy:query.weights},availableRegistry);
      const values=new Map(w.maps.map(m=>[m.matchId,m.weight]));
      const usable=w.status==='computed_candidate'&&w.summary.missingMaps===0&&w.summary.positiveWeightMaps>0;
      const metrics=usable?weightedSample(rows.map(r=>({matchId:r.map.matchId,won:r.won,weight:values.get(r.map.matchId)!})),query.weights.version):null;
      weighted={status:usable?'computed_candidate':'unavailable',validation:'unvalidated_candidate',rate:metrics?.weightedRate??null,nEff:metrics?.nEff??null,
        nKnown:w.summary.weightedMaps,nPositive:w.summary.positiveWeightMaps,nMissing:w.summary.missingMaps,targetPatchId:w.targetPatch.value,patchColdStart:w.patchColdStart,
        cacheKey:createHash('sha256').update(w.cacheKey+registryFingerprint).digest('hex'),
        reasons:[...new Set([...w.maps.flatMap(m=>m.reasons),...(!nRaw?['NO_OBSERVATIONS']:w.summary.positiveWeightMaps===0?['NO_POSITIVE_WEIGHTS']:[]),...(w.targetPatch.reason?[w.targetPatch.reason]:[])])].sort(),
        maps:w.maps.map(({matchId,weight,reasons,proofIds})=>({matchId,weight,reasons,proofIds}))};
    }
    const distribution=new Map<string|null,number>();for(const r of rows)distribution.set(r.map.patchId,(distribution.get(r.map.patchId)??0)+1);
    return {kind,teamSlot:kind==='ally'?a.teamSlot:null,heroA:a,heroB:b,nRaw,wins,winRate:nRaw?wins/nRaw:null,sampleEvidence:SampleEvidenceSchema.parse(sampleEvidence(nRaw)),
      patchDistribution:[...distribution].map(([patchId,nRaw])=>({patchId,nRaw})),smoothing,weighted};
  }
  const allies:HeroPairStat[]=[],enemies:HeroPairStat[]=[];
  for(let i=0;i<heroes.length;i++)for(let j=i+1;j<heroes.length;j++)if(heroes[i]!.teamSlot===heroes[j]!.teamSlot)allies.push(stat('ally',heroes[i]!,heroes[j]!));
  for(const a of heroes.filter(h=>h.teamSlot==='A'))for(const b of heroes.filter(h=>h.teamSlot==='B'))enemies.push(stat('enemy',a,b));
  const warnings=['RETROSPECTIVE_NOT_HISTORICAL_FEATURES','HERO_PAIRS_NOT_PLAYER_OR_TEAM_STATS','MODEL_NOT_READY','S1_07_EMPIRICAL_GATE_OPEN'];
  if(cutoffAt!==snapshot.input.cutoffAt)warnings.push('FUTURE_CUTOFF_CLAMPED');if(target.coverage.partialHeroMaps)warnings.push('PARTIAL_HERO_MAPS');
  if(reference===null)warnings.push('REFERENCE_TOO_LARGE');if(query.weights)warnings.push('UNVALIDATED_WEIGHT_POLICY');
  const dataUpdatedAt=target.maps.reduce<string|null>((v,m)=>v===null||m.syncedAt>v?m.syncedAt:v,null);
  const fingerprint=createHash('sha256').update(canonicalContextJson({scenarioId:snapshot.id,revision:snapshot.revision,inputHash:snapshot.inputHash,query,fromAt,cutoffAt,
    registryRevision:registry.revision,registryFingerprint,policy:'hero-pairs-v1',target,reference,
    candidates:candidates.map(m=>({matchId:m.matchId,dataRevision:m.dataRevision})),referenceCandidates:referenceCandidates?.map(m=>({matchId:m.matchId,dataRevision:m.dataRevision}))??null})).digest('hex');
  return HeroMatchupReportSchema.parse({status:[...allies,...enemies].some(p=>p.nRaw)?'ready':'insufficient_data',scope:'retrospective_hero_pairs',policyVersion:'hero-pairs-v1',
    scenarioId:snapshot.id,scenarioRevision:snapshot.revision,scenarioInputHash:snapshot.inputHash,query,snapshotAt,requestedCutoffAt:snapshot.input.cutoffAt,cutoffAt,fromAt,
    currentPatchId,effectivePatchId,targetLeagueId:snapshot.input.context.leagueId??null,registryRevision:registry.revision,fingerprint,heroes,allies,enemies,coverage:target.coverage,
    reference:{status:reference?'ready':'unavailable',reason:reference?null:'REFERENCE_TOO_LARGE',beforeAt:fromAt,coverage:reference?.coverage??null,excludedSeriesIds:[...excludedSeries].sort(),provenance:reference?.maps??[]},
    provenance:target.maps,dataUpdatedAt,warnings,model:null,teamAWinProbability:null});
}
