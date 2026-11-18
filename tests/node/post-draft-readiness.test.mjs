import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarizePostDraftRows} from '../../tools/audits/audit-post-draft-readiness.mjs';
const row=()=>{const players=Array.from({length:10},(_,i)=>({player_slot:i<5?i:i+123,hero_id:i+1,player_id:String(i+1)}));return {
 matchId:'1',startedAt:'2026-01-01T00:00:00.000Z',players,source:{match_id:1,patch:60,players:structuredClone(players),picks_bans:players.map((p,i)=>({is_pick:true,hero_id:p.hero_id,team:i<5?0:1,order:i}))},
 sourceSnapshotId:'1',sourceSha256:'a'.repeat(64),canonicalPatchId:null,leagueId:'1',seriesId:'s',teamAId:'1',teamBId:'2',outcomeStatus:'eligible',ingestState:'accepted'};};
test('observed final heroes remain separate from missing, extra and wrong-side raw picks',()=>{
 for(const kind of ['missing','extra','wrong-side']){const r=row();if(kind==='missing')r.source.picks_bans=null;else if(kind==='extra')r.source.picks_bans.push({is_pick:true,hero_id:11,team:0,order:10});else r.source.picks_bans[0].team=1;
 const before=JSON.stringify(r),report=summarizePostDraftRows([r]);assert.equal(report.coverage.finalHeroes.count,1);assert.equal(report.coverage.rawStructureConsistent.count,0);assert.equal(report.coverage.researchInventoryCandidate.count,1);assert.equal(report.trainingReady,false);assert.equal(report.deployable,false);assert.equal(JSON.stringify(r),before);}
});
test('duplicate heroes, slot identity changes, missing receipt and missing canonical links are excluded independently',()=>{
 for(const kind of ['hero','slot','source','player','series','teams','outcome','conflict']){const r=row();if(kind==='hero')r.players[0].hero_id=2;else if(kind==='slot')r.players[0].player_slot=128;else if(kind==='source')r.source=null;else if(kind==='player')r.players[0].player_id=null;else if(kind==='series')r.seriesId=null;else if(kind==='teams')r.teamBId='1';else if(kind==='outcome')r.outcomeStatus='unknown';else r.ingestState='conflict';
 const report=summarizePostDraftRows([r]);assert.equal(report.coverage.researchInventoryCandidate.count,0,kind);if(kind==='source'){assert.equal(report.coverage.sourceHeroesAgree.unknown,1);assert.equal(report.coverage.sourceHeroesAgree.ratio,null);assert.equal(report.coverage.sourceHeroesAgree.of,0);}}
 const r=row();[r.source.players[0].hero_id,r.source.players[1].hero_id]=[2,1];assert.equal(summarizePostDraftRows([r]).coverage.sourceHeroesAgree.count,0);
});
test('empty inventory has null ratios; duplicate map rows never inflate sample size',()=>{
 assert.equal(summarizePostDraftRows([]).coverage.finalHeroes.ratio,null);assert.throws(()=>summarizePostDraftRows([row(),row()]),/duplicate_map/);
 const r=row();r.matchId='9007199254740993';r.source.match_id=r.matchId;assert.equal(summarizePostDraftRows([r]).maps[0].matchId,r.matchId);
});

test('fingerprints preserve actual canonical lineup changes while ignoring source array ordering',()=>{
 const a=row(),b=row();b.players.reverse();const first=summarizePostDraftRows([a]).maps[0];assert.equal(first.lineupSha256,summarizePostDraftRows([b]).maps[0].lineupSha256);
 b.players[0].player_id='42';assert.notEqual(first.lineupSha256,summarizePostDraftRows([b]).maps[0].lineupSha256);
});
