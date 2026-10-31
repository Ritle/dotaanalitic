import {DraftAssessmentSchema,type DraftAssessment,type ScenarioInput,type GameRegistry} from '@dota/contracts';
import {resolveHeroAt,resolvePatchAt} from './game-context.js';
/** Hypothetical scenario diagnostics; never a verified match context or model gate. */
export function assessScenarioDraft(input:ScenarioInput,registry:GameRegistry,checkedAt:string):DraftAssessment {
  const knowledgeAt=input.cutoffAt<checkedAt?input.cutoffAt:checkedAt,mapTime=input.scheduledAt,leagueId=input.context.leagueId??null;
  const patch=mapTime===null?{value:null,reason:'MAP_TIME_UNKNOWN',evidenceIds:[]}:resolvePatchAt(registry.patches,mapTime,knowledgeAt);
  const draft=input.draft??{assignments:[],bans:[]};
  const heroes=[...draft.assignments.map(p=>({...p,action:'pick' as const})),...draft.bans.map(p=>({...p,rolePos:null,action:'ban' as const}))].map(p=>({...p,
    decision:mapTime===null?{value:null,reason:'MAP_TIME_UNKNOWN',evidenceIds:[]}:resolveHeroAt(registry.heroRules,p.heroId,patch.value,leagueId,mapTime,knowledgeAt)}));
  const warnings=new Set<string>(['MODEL_NOT_READY','DRAFT_TIMELINE_NOT_VALIDATED']);
  if(mapTime===null)warnings.add('MAP_TIME_UNKNOWN');if(leagueId===null)warnings.add('LEAGUE_UNKNOWN');
  if(patch.reason)warnings.add(patch.reason==='CONFLICT'?'PATCH_CONFLICT':patch.reason);
  if(draft.assignments.length!==10)warnings.add('INCOMPLETE_DRAFT');
  if(heroes.some(h=>h.decision.value===null))warnings.add('HERO_ELIGIBILITY_UNKNOWN');
  if(heroes.some(h=>h.decision.reason==='CONFLICT'))warnings.add('HERO_ELIGIBILITY_CONFLICT');
  const blocked=heroes.some(h=>h.decision.value===false);if(blocked)warnings.add('HERO_INELIGIBLE');
  const patchIds=new Set(patch.evidenceIds),heroIds=new Set(heroes.flatMap(h=>h.decision.evidenceIds));
  const proofs=[...registry.patches.filter(r=>patchIds.has(r.id)).map(r=>({...r,kind:'patch' as const})),
    ...registry.heroRules.filter(r=>heroIds.has(r.id)).map(r=>({...r,kind:'hero' as const}))]
    .map(({id,kind,source,evidenceRef,eventAt,knownAt,fetchedAt,reviewState})=>({id,kind,source,evidenceRef,eventAt,knownAt,fetchedAt,reviewState}));
  return DraftAssessmentSchema.parse({status:blocked?'blocked':!heroes.length||patch.value===null||leagueId===null||heroes.some(h=>h.decision.value===null)?'unknown':'available',
    policyVersion:'scenario-draft-v1',registryRevision:registry.revision,checkedAt,knowledgeAt,mapTime,leagueId,patch,
    assignedHeroes:draft.assignments.length,fullDraft:draft.assignments.length===10,draftOrderValidated:false,heroes,proofs,warnings:[...warnings].sort(),
    predictionStatus:'unavailable',teamAWinProbability:null});
}
