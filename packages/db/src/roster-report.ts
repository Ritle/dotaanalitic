import {describeRoster,compareRosters,describeChurn,type RosterSide} from '@dota/analytics';
import {RosterReportSchema,type RosterRequest,type GameRegistry,type StoredAccountEvidence} from '@dota/contracts';
import type {ProMapCandidate} from './pro-maps.js';
import {resolveIdentity} from './identity.js';
import {resolvePatchAt} from './game-context.js';
import {canonicalContextJson} from './temporal.js';

/** Current descriptive evidence, never an as-of feature builder or published lineup assertion. */
export function buildRosterReport(organizationId:string,input:RosterRequest,cutoffAt:string,snapshotAt:string,candidates:readonly ProMapCandidate[],
  evidence:readonly StoredAccountEvidence[],registry:GameRegistry,identityRevision:string){
  const byAccount=new Map<string,StoredAccountEvidence[]>();
  for(const e of evidence)if(e.fetchedAt<=snapshotAt&&(e.eventAt===null||e.eventAt<=snapshotAt)&&(e.knownAt===null||e.knownAt<=snapshotAt)){
    const group=byAccount.get(e.externalAccountId)??[];group.push(e);byAccount.set(e.externalAccountId,group);
  }
  const identities=new Map([...byAccount].map(([account,rows])=>[account,resolveIdentity(rows,account,null)]));
  const verifiedIds=new Set([...identities.values()].flatMap(r=>r.playerId??[]));
  const recentFrom=new Date(Math.max(0,Date.parse(cutoffAt)-90*86400000)).toISOString();
  const coverage={candidates:candidates.length,unknownPro:0,nonPro:0,conflict:0,unfinished:0,eligibleMaps:0,incompleteSides:0,duplicateIdentityMaps:0,
    knownPatchMaps:0,lateFetchedMaps:0,sourceFetchUnknown:0};
  const sides:RosterSide[]=[],provenance:ReturnType<typeof RosterReportSchema.parse>['provenance']=[],seen=new Set<string>();
  for(const m of candidates){
    if(seen.has(m.matchId))throw new Error('duplicate_canonical_map');seen.add(m.matchId);
    if(m.startedAt>=cutoffAt||input.fromAt&&m.startedAt<input.fromAt)throw new Error('candidate_outside_window');
    if(m.isPro!==true){if(m.isPro===null)coverage.unknownPro++;else coverage.nonPro++;continue;}
    if(m.conflict){coverage.conflict++;continue;}
    if(!m.completed||m.radiantWin===null||m.durationSeconds===null||m.durationSeconds<=0){coverage.unfinished++;continue;}
    const players=m.players.map(p=>({...p,identity:p.sourceAccountId===null?null:identities.get(p.sourceAccountId)??null}));
    const ids=players.flatMap(p=>p.identity?.playerId??[]),duplicate=new Set(ids).size!==ids.length;
    if(duplicate)coverage.duplicateIdentityMaps++;
    const facts=m.observations.filter(r=>r.matchId===m.matchId&&r.fact.field==='roles'&&r.fetchedAt<=snapshotAt&&
      (r.eventAt===null||r.eventAt<=snapshotAt)&&(r.knownAt===null||r.knownAt<=snapshotAt)&&r.evidenceRef!==null&&
      ['verified_asof','retrospective_fact'].includes(r.availability)&&['accepted','conflict'].includes(r.reviewState));
    const roleConflict=facts.some(r=>r.reviewState==='conflict')||new Set(facts.map(r=>canonicalContextJson(r.fact))).size>1;
    const fact=roleConflict?null:facts[0]?.fact;
    const confirmed=(fact?.field==='roles'?fact.value??[]:[]).filter(r=>r.playerId!==null&&r.rolePos!==null&&r.basis==='confirmed'&&
      (r.confidence===null||r.confidence===1)&&players.some(p=>p.playerSlot===r.playerSlot&&p.identity?.playerId===r.playerId));
    const patch=resolvePatchAt(registry.patches.filter(p=>p.fetchedAt<=snapshotAt),m.startedAt,snapshotAt);
    coverage.eligibleMaps++;if(patch.value!==null)coverage.knownPatchMaps++;
    if(m.sourceFetchedAt===null)coverage.sourceFetchUnknown++;else if(m.sourceFetchedAt>cutoffAt)coverage.lateFetchedMaps++;
    for(const side of ['radiant','dire'] as const){
      const base=side==='radiant'?0:128;
      const members=Array.from({length:5},(_,i)=>{
        const found=players.filter(p=>p.playerSlot===base+i),playerId=!duplicate&&found.length===1?found[0]!.identity?.playerId??null:null;
        const role=confirmed.find(r=>r.playerSlot===base+i&&r.playerId===playerId);
        const rolePos=role&&confirmed.filter(r=>(r.playerSlot<128)===(base===0)&&r.rolePos===role.rolePos).length===1?role.rolePos:null;
        return {playerId,rolePos};
      });
      if(members.some(p=>p.playerId===null))coverage.incompleteSides++;
      sides.push({matchId:m.matchId,startedAt:m.startedAt,side,organizationId:side==='radiant'?m.radiantTeamId:m.direTeamId,
        won:side==='radiant'?m.radiantWin:!m.radiantWin,patchId:patch.value,syncedAt:m.syncedAt,players:members});
    }
    provenance.push({matchId:m.matchId,dataRevision:m.dataRevision,source:m.source,syncedAt:m.syncedAt,sourceFetchedAt:m.sourceFetchedAt,
      identityProofIds:[...new Set(players.flatMap(p=>p.identity?.observationIds??[]))].sort(),roleProofIds:facts.map(r=>r.id),patchProofIds:patch.evidenceIds});
  }
  const actual=describeRoster(input.lineup,sides,verifiedIds,recentFrom,organizationId);
  const expected=input.expectedLineup?describeRoster(input.expectedLineup,sides,verifiedIds,recentFrom,organizationId):null;
  const comparison=compareRosters(input.expectedLineup,input.lineup),churn=describeChurn(sides,organizationId,20);
  const warnings=['RETROSPECTIVE_NOT_HISTORICAL_FEATURES','LOCAL_HISTORY_NOT_EXHAUSTIVE'];
  if(actual.fingerprint===null)warnings.push('UNKNOWN_PLAYER_IDS');
  if(comparison===null)warnings.push('EXPECTED_LINEUP_MISSING');
  if(actual.exactFive.nRaw===0)warnings.push('NO_OBSERVED_EXACT_FIVE');
  if(input.lineup.some(p=>p.isStandin))warnings.push('STANDIN_DECLARED');
  if(coverage.incompleteSides)warnings.push('INCOMPLETE_HISTORICAL_LINEUPS');
  if(coverage.duplicateIdentityMaps)warnings.push('DUPLICATE_CANONICAL_IDENTITY');
  if(coverage.knownPatchMaps<coverage.eligibleMaps)warnings.push('PATCH_UNKNOWN');
  if(coverage.lateFetchedMaps)warnings.push('SOURCE_FETCHED_AFTER_CUTOFF');
  if(coverage.sourceFetchUnknown)warnings.push('SOURCE_FETCH_UNKNOWN');
  if(actual.players.some(p=>p.confirmedRoleMaps!==p.nRaw))warnings.push('ROLE_COVERAGE_PARTIAL');
  if(churn.changedTransitions!==null&&churn.changedTransitions>0)warnings.push('ROSTER_CHURN');
  return RosterReportSchema.parse({status:actual.fingerprint===null||coverage.incompleteSides?'partial':actual.exactFive.nRaw===0?'insufficient_data':'ready',
    scope:'retrospective_descriptive',policyVersion:'roster-display-v1',organizationId,input,cutoffAt,snapshotAt,recentFrom,recentDays:90,
    source:'normalized_local_maps',identityRevision,registryRevision:registry.revision,model:null,predictionEligibility:'not_assessed',
    actual,expected,comparison,churn,coverage,provenance,warnings});
}
