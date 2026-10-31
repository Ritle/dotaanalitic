import type {PatchMetaRegistry} from '../src/patch-history.js';
import type {HistoryWeightPolicy,PatchHistoryRequest} from '@dota/contracts';
export const policy:HistoryWeightPolicy={version:'synthetic-transfer-v1',validation:'unvalidated_candidate',
  draft:{halfLifeDays:60,transitionPenalties:{minor:0.05,moderate:0.2,major:0.7},heroFactors:{unchanged:1,minor:0.9,moderate:0.6,major:0.25,rework:0}},
  strength:{halfLifeDays:180,transitionPenalties:{minor:0.01,moderate:0.03,major:0.08}}};
export const old='2023-01-01T00:00:00.000Z',release='2024-01-01T00:00:00.000Z',cutoff='2024-01-03T00:00:00.000Z';
export const proof={eventAt:release,knownAt:release,fetchedAt:'2026-01-01T00:00:00.000Z',source:'synthetic',evidenceRef:'synthetic:patch-notes',reviewState:'accepted' as const};
export function patchRegistry():PatchMetaRegistry{return {revision:'5',draftRules:[],
  patches:[{...proof,id:'1',eventAt:old,knownAt:old,patchId:'1',releasedAt:old,coverageUntil:release},
    {...proof,id:'2',patchId:'2',releasedAt:release,coverageUntil:'2025-01-01T00:00:00.000Z'}],
  heroRules:[{...proof,id:'3',patchId:'2',heroId:1,leagueId:null,allowed:true,validFrom:release,validTo:null},
    {...proof,id:'4',eventAt:old,knownAt:old,patchId:'1',heroId:1,leagueId:null,allowed:true,validFrom:old,validTo:release}],
  transitions:[{...proof,id:'1',fromPatchId:'1',patchId:'2',changeLevel:'major'}],
  heroImpacts:[{...proof,id:'1',patchId:'2',heroId:1,impactLevel:'rework'}]};}
export function weightRequest():PatchHistoryRequest{return {cutoffAt:cutoff,leagueId:'100',feature:'draft_hero',heroIds:[1],policy,
  maps:[{matchId:'9007199254740993',startedAt:'2023-12-30T00:00:00.000Z'},{matchId:'2',startedAt:'2024-01-02T00:00:00.000Z'}]};}
