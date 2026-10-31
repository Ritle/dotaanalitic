import {createHash} from 'node:crypto';
import {historyWeight,historyWeightSummary} from '@dota/analytics';
import {PatchHistoryRequestSchema,PatchTransitionEvidenceSchema,HeroImpactEvidenceSchema,
  type PatchHistoryRequest,type PatchTransitionEvidence,type HeroImpactEvidence,type GameRegistry} from '@dota/contracts';
import {resolvePatchAt,resolveHeroAt} from './game-context.js';
import {canonicalContextJson} from './temporal.js';
export type PatchMetaRegistry=GameRegistry&{transitions:(PatchTransitionEvidence&{id:string})[];heroImpacts:(HeroImpactEvidence&{id:string})[]};

/** Assigns weights to caller-supplied map IDs, never certifies map/lineup/label eligibility. */
export function resolveHistoryWeights(input:PatchHistoryRequest,registry:PatchMetaRegistry){
  const q=PatchHistoryRequestSchema.parse(input);q.heroIds.sort((a,b)=>a-b);
  const target=resolvePatchAt(registry.patches,q.cutoffAt,q.cutoffAt);
  const eligible=(r:{knownAt:string;eventAt:string;reviewState:string})=>r.knownAt<=q.cutoffAt&&r.eventAt<=q.cutoffAt&&['accepted','conflict'].includes(r.reviewState);
  const transitions=registry.transitions.map(({id,...r})=>({id,...PatchTransitionEvidenceSchema.parse(r)})).filter(eligible);
  const impacts=registry.heroImpacts.map(({id,...r})=>({id,...HeroImpactEvidenceSchema.parse(r)})).filter(eligible);
  const releases=registry.patches.filter(r=>r.knownAt<=q.cutoffAt&&(r.eventAt===null||r.eventAt<=q.cutoffAt)&&['accepted','conflict'].includes(r.reviewState));
  const heroEligibility=q.feature==='draft_hero'?q.heroIds.map(heroId=>({heroId,...resolveHeroAt(registry.heroRules,heroId,target.value,q.leagueId,q.cutoffAt,q.cutoffAt)})):[];
  const maps=[...q.maps].sort((a,b)=>a.startedAt.localeCompare(b.startedAt)||(BigInt(a.matchId)<BigInt(b.matchId)?-1:1)).map(m=>{
    const patch=resolvePatchAt(registry.patches,m.startedAt,q.cutoffAt),reasons:string[]=[],proofIds=new Set<string>();
    const add=(kind:string,ids:string[])=>ids.forEach(id=>proofIds.add(kind+':'+id));
    add('release',target.evidenceIds);add('release',patch.evidenceIds);
    const penalties:number[]=[],factors:number[]=[],settings=q.feature==='draft_hero'?q.policy.draft:q.policy.strength;
    if(target.value===null)reasons.push(target.reason==='CONFLICT'?'TARGET_PATCH_CONFLICT':'TARGET_'+target.reason);
    if(patch.value===null)reasons.push(patch.reason==='CONFLICT'?'HISTORY_PATCH_CONFLICT':'HISTORY_'+patch.reason);
    for(const h of heroEligibility){add('availability',h.evidenceIds);if(h.value!==true)reasons.push(h.value===false?'HERO_INELIGIBLE':h.reason==='CONFLICT'?'HERO_ELIGIBILITY_CONFLICT':'HERO_ELIGIBILITY_UNKNOWN');}
    const dates=[...new Set(releases.filter(r=>r.releasedAt>m.startedAt&&r.releasedAt<=q.cutoffAt).map(r=>r.releasedAt))].sort();
    let previous=patch.value;
    for(const date of dates){
      const before=resolvePatchAt(registry.patches,new Date(Date.parse(date)-1).toISOString(),q.cutoffAt),next=resolvePatchAt(registry.patches,date,q.cutoffAt);
      add('release',before.evidenceIds);add('release',next.evidenceIds);
      if(previous===null||before.value!==previous||next.value===null){reasons.push('PATCH_PATH_UNKNOWN');previous=next.value;continue;}
      const rows=transitions.filter(r=>r.patchId===next.value);add('transition',rows.map(r=>r.id));
      if(!rows.length)reasons.push('PATCH_TRANSITION_UNKNOWN');
      else if(rows.some(r=>r.reviewState==='conflict'||r.eventAt!==date||r.fromPatchId!==previous)||new Set(rows.map(r=>r.changeLevel)).size!==1)reasons.push('PATCH_TRANSITION_CONFLICT');
      else penalties.push(settings.transitionPenalties[rows[0]!.changeLevel]);
      if(q.feature==='draft_hero')for(const heroId of q.heroIds){
        const hs=impacts.filter(r=>r.patchId===next.value&&r.heroId===heroId);add('impact',hs.map(r=>r.id));
        if(!hs.length)reasons.push('HERO_IMPACT_UNKNOWN');
        else if(hs.some(r=>r.reviewState==='conflict'||r.eventAt!==date)||new Set(hs.map(r=>r.impactLevel)).size!==1)reasons.push('HERO_IMPACT_CONFLICT');
        else factors.push(q.policy.draft.heroFactors[hs[0]!.impactLevel]);
      }
      previous=next.value;
    }
    if(previous!==target.value)reasons.push('PATCH_PATH_UNKNOWN');
    const ageDays=(Date.parse(q.cutoffAt)-Date.parse(m.startedAt))/86400000;
    const result=reasons.length?null:historyWeight(ageDays,settings.halfLifeDays,penalties,factors);
    return {...m,patchId:patch.value,ageDays,...(result??{timeWeight:null,patchWeight:null,heroWeight:null,weight:null}),reasons:[...new Set(reasons)].sort(),proofIds:[...proofIds].sort()};
  });
  const distribution=new Map<string|null,number>();for(const m of maps)distribution.set(m.patchId,(distribution.get(m.patchId)??0)+1);
  const targetPatchMaps=maps.filter(m=>target.value!==null&&m.patchId===target.value).length;
  const request={...q,heroIds:[...q.heroIds].sort((a,b)=>a-b),maps:maps.map(({matchId,startedAt})=>({matchId,startedAt}))};
  const cacheKey=createHash('sha256').update(canonicalContextJson({request,registryRevision:registry.revision,resolverVersion:'patch-transfer-v1'})).digest('hex');
  return {status:maps.some(m=>m.weight===null)||target.value===null?'unavailable' as const:'computed_candidate' as const,
    cutoffAt:q.cutoffAt,feature:q.feature,heroIds:q.heroIds,leagueId:q.leagueId,registryRevision:registry.revision,policy:q.policy,
    policyVersion:'patch-transfer-v1',cacheKey,targetPatch:target,heroEligibility,maps,summary:historyWeightSummary(maps.map(m=>m.weight)),
    patchDistribution:[...distribution].map(([patchId,nRaw])=>({patchId,nRaw})),targetPatchMaps,
    patchColdStart:target.value===null?null:targetPatchMaps===0,currentPatchShare:target.value!==null&&maps.length?targetPatchMaps/maps.length:null,
    predictionEligibility:'not_assessed',teamAWinProbability:null,deployable:false as const};
}
