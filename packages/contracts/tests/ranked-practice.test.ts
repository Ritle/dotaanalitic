import {expect,test} from 'vitest';
import {RankedPracticeHeroSummarySchema,RankedPracticeReportSchema} from '../src/ranked-practice.js';
const empty={games:0,wins:0,winRate:null,lastPlayedAt:null,heroes:[],observationId:'11111111-1111-4111-8111-111111111111',policyVersion:'ranked-hero-raw-v1',roleScope:'all_roles',weighted:false};
test('empty summary is nullable history, not zero observed win rate',()=>{
 expect(RankedPracticeHeroSummarySchema.parse(empty)).toEqual(empty);
 expect(RankedPracticeHeroSummarySchema.safeParse({...empty,winRate:0}).success).toBe(false);
});
test('hero counts, unique IDs and raw ratios must conserve observed totals',()=>{
 const lastPlayedAt='2026-10-02T00:00:00.000Z',hero={heroId:'1',heroName:null,games:1,wins:1,winRate:1,lastPlayedAt},valid={...empty,games:1,wins:1,winRate:1,lastPlayedAt,heroes:[hero]};
 expect(RankedPracticeHeroSummarySchema.safeParse(valid).success).toBe(true);
 for(const invalid of [{...valid,wins:0},{...valid,heroes:[]},{...valid,heroes:[hero,hero]},{...valid,heroes:[{...hero,winRate:0.5}]}])expect(RankedPracticeHeroSummarySchema.safeParse(invalid).success).toBe(false);
});
const report={playerId:'1',accountId:'1000',provider:'opendota',snapshotAt:'2026-10-31T00:00:00.000Z',identityRevision:'1',observationIdentityRevision:null,identityStatus:'verified',status:'not_loaded',stale:false,reason:'not_loaded',retryAt:null,observationId:null,observation:null,statisticsEnabled:false};
test('legacy reports remain readable but cannot enable statistics without a supported observation',()=>{
 expect(RankedPracticeReportSchema.parse(report).heroSummary).toBeNull();
 expect(RankedPracticeReportSchema.safeParse({...report,statisticsEnabled:true}).success).toBe(false);
 expect(RankedPracticeReportSchema.safeParse({...report,statisticsEnabled:true,heroSummary:empty}).success).toBe(false);
});
test('summary requires audited source, verified account, current adapter and exact per-hero observations',()=>{
 const startedAt='2026-10-02T00:00:00.000Z',observationId=empty.observationId,
  map={matchId:'1',accountId:'1000',heroId:'1',startedAt,completedAt:'2026-10-02T01:00:00.000Z',completionBasis:'start_plus_duration',side:'dire',win:true,patchCode:null,position:null,roleBasis:'unknown',averageRank:null,partySize:null},
  observation={adapterVersion:'ranked-practice-reader-v2',provider:'opendota',accountId:'1000',fromAt:'2026-10-01T00:00:00.000Z',cutoffAt:report.snapshotAt,knownAt:null,fetchedAt:report.snapshotAt,filters:{lobbyTypeId:7,gameModeId:22,windowDays:30,qualityFilter:'none'},maps:[map],coverage:{receivedRows:1,excluded:{},duplicates:0,conflicts:0,pagination:'capped',historyCompleteness:'unknown',stopReason:null},receipts:[{offset:0,rows:1,fetchedAt:report.snapshotAt,payloadSha256:'a'.repeat(64)}]},
  hero={heroId:'1',heroName:null,games:1,wins:1,winRate:1,lastPlayedAt:startedAt},heroSummary={...empty,games:1,wins:1,winRate:1,lastPlayedAt:startedAt,heroes:[hero]},valid={...report,status:'partial',reason:null,observationId,observationIdentityRevision:'1',observation,statisticsEnabled:true,heroSummary};
 expect(RankedPracticeReportSchema.safeParse(valid).success).toBe(true);
 for(const invalid of [{...valid,provider:'stratz'},{...valid,identityStatus:'unknown'},{...valid,accountId:'1001'},{...valid,observation:{...observation,adapterVersion:'ranked-practice-reader-v1'}},{...valid,observation:{...observation,coverage:{...observation.coverage,conflicts:1}}},{...valid,heroSummary:{...heroSummary,heroes:[{...hero,heroId:'2'}]}},{...valid,heroSummary:{...heroSummary,observationId:'22222222-2222-4222-8222-222222222222'}}])expect(RankedPracticeReportSchema.safeParse(invalid).success).toBe(false);
});
