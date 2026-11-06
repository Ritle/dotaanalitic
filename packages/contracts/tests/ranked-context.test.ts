import {expect,test} from 'vitest';
import {RankedContextReceiptSchema,RankedContextReportSchema,RankedContextRequestSchema} from '../src/ranked-context.js';
const uuid='11111111-1111-4111-8111-111111111111',at='2026-11-06T00:00:00.000Z',map={matchId:'1',heroId:'1',startedAt:'2026-11-05T00:00:00.000Z',status:'not_loaded',reason:'not_loaded',position:null,roleBasis:'unknown',gameVersionCode:null,averageRank:null,sourceReceiptId:null,sourceParentObservationId:null,sourceFetchedAt:null,sourceSha256:null,stale:false},
 report={playerId:'1',parentObservationId:uuid,accountId:'1000',identityRevision:'1',provider:'stratz',policyVersion:'stratz-known-ranked-map-v1',snapshotAt:at,status:'not_loaded',reason:null,retryAt:null,parentFromAt:'2026-10-07T00:00:00.000Z',parentCutoffAt:at,parentGames:1,selectedMaps:1,matchedMaps:0,maps:[map]};
test('context request accepts only owner-selected parent and player, not arbitrary IDs or counters',()=>{
 expect(RankedContextRequestSchema.parse({playerId:'1',parentObservationId:uuid}).refresh).toBe(false);
 for(const v of [{playerId:1,parentObservationId:uuid},{playerId:'1',parentObservationId:'invalid'},{playerId:'1',parentObservationId:uuid,accountId:'1000'},{playerId:'1',parentObservationId:uuid,matchIds:['1']}])expect(RankedContextRequestSchema.safeParse(v).success).toBe(false);
});
test('report counts, parent window and ready status must agree with applied rows',()=>{
 expect(RankedContextReportSchema.safeParse(report).success).toBe(true);
 for(const v of [{...report,matchedMaps:1},{...report,parentGames:0},{...report,status:'ready'},{...report,maps:[{...map,startedAt:at}]},{...report,maps:[map,map],parentGames:2,selectedMaps:2}])expect(RankedContextReportSchema.safeParse(v).success).toBe(false);
});
test('unverified/conflicting context cannot expose applied metadata; matched rows need source provenance',()=>{
 const matched={...map,status:'matched',reason:null,position:'POSITION_2',roleBasis:'estimated',gameVersionCode:'190',sourceReceiptId:uuid,sourceParentObservationId:uuid,sourceFetchedAt:at,sourceSha256:'a'.repeat(64)};
 expect(RankedContextReportSchema.safeParse({...report,status:'ready',matchedMaps:1,maps:[matched]}).success).toBe(true);
 for(const row of [{...map,position:'POSITION_2'},{...matched,sourceReceiptId:null},{...matched,roleBasis:'unknown'},{...matched,status:'conflict',reason:'hero_mismatch'}])expect(RankedContextReportSchema.safeParse({...report,status:'partial',matchedMaps:row.status==='matched'?1:0,maps:[row]}).success).toBe(false);
});
test('source receipt binds entries to account and match IDs and rejects duplicate/bad status shapes',()=>{
 const entry={matchId:'1',status:'missing',reason:'source_map_unavailable',map:null},receipt={policyVersion:'stratz-known-ranked-map-v1',provider:'stratz',accountId:'1000',knownAt:null,fetchedAt:at,payloadSha256:'a'.repeat(64),entries:[entry]};
 expect(RankedContextReceiptSchema.safeParse(receipt).success).toBe(true);
 for(const entries of [[entry,entry],[{...entry,status:'found'}],[],Array.from({length:5},(_,i)=>({...entry,matchId:String(i+1)}))])expect(RankedContextReceiptSchema.safeParse({...receipt,entries}).success).toBe(false);
});
