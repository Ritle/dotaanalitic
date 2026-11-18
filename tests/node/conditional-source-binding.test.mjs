import test from 'node:test';
import assert from 'node:assert/strict';
import {bindConditionalFutureSources as bind,inspectConditionalSources,sourceSha} from '../../tools/research/conditional-future-source-binding.mjs';
import {sourceFixture,bindFixture} from '../fixtures/conditional-source-binding.mjs';
const run=f=>bind(f.input,f.archive);
test('binds native map/series/event, source identities and completed labels in separate output',()=>{
 const f=sourceFixture(),before=structuredClone(f),r=run(f);
 assert.equal(r.features.pairedMaps,2);assert.equal(r.labels.rows.length,2);assert(r.sourceLedger.rows.every(x=>x.status==='source_bound'));
 assert.equal(r.sourceLedger.remoteInventoryComplete,false);assert.equal(r.sourceLedger.deployable,false);
 assert.equal(JSON.stringify(r.features).includes('teamAWon'),false);assert.deepEqual(f,before);
});
test('target winner reversal changes only labels and provenance, not numeric features',()=>{
 const f=sourceFixture(),r=run(f),receipt=f.archive.receipts.find(x=>x.matchId===f.input.cases[0].target.matchId);
 const p=JSON.parse(receipt.rawBody);p.radiant_win=false;receipt.rawBody=JSON.stringify(p);bindFixture(f);
 const changed=run(f);assert.equal(changed.labels.rows[0].teamAWon,false);
 assert.deepEqual(changed.features.rows.map(x=>x.inputs),r.features.rows.map(x=>x.inputs));
});
test('canonical team ID order determines label orientation independently of native IDs',()=>{
 const f=sourceFixture();[f.archive.teams[0].canonicalId,f.archive.teams[1].canonicalId]=['20','10'];bindFixture(f);
 const r=run(f);assert(r.labels.rows.every(x=>x.teamASide==='dire'&&!x.teamAWon));assert.equal(r.features.pairedMaps,2);
});
for(const [name,mutate] of [
 ['target hero',f=>f.input.cases[0].target.players[0].heroId=77],
 ['target event',f=>f.input.cases[0].target.eventId='301'],
 ['target series',f=>{for(const c of f.input.cases)c.target.seriesKey='["opendota","100"]';f.input.series[0].seriesKey='["opendota","100"]';}],
 ['target start',f=>f.input.cases[0].target.startedAtUs=String(BigInt(f.input.cases[0].target.startedAtUs)+1n)],
 ['history winner',f=>f.input.cases[0].history.maps[0].teamAWon=!f.input.cases[0].history.maps[0].teamAWon],
 ['history hero',f=>f.input.cases[0].heroHistory.maps[0].players[0].heroId=77],
 ['history fact clock',f=>f.input.cases[0].history.maps[0].labelVerifiedAtUs=String(BigInt(f.input.cases[0].history.maps[0].labelVerifiedAtUs)+1n)],
 ['forged identity',f=>f.input.cases[0].history.identities[0].playerId='999'],
])test(name+' mismatch never silently overwrites source or drops denominator',()=>{
 const f=sourceFixture();mutate(f);const r=run(f);assert.equal(r.features.denominator,2);assert.equal(r.features.pairedMaps,0);
 assert.equal(r.sourceLedger.rows[0].status,'unavailable');
});
test('non-pro/unknown league or incomplete outcome is unavailable despite declared isPro true',()=>{
 for(const change of ['amateur','missing_winner','before_completion']){
  const f=sourceFixture(),receipt=f.archive.receipts.find(r=>r.matchId===f.input.cases[0].target.matchId);
  if(change==='amateur'){f.archive.leagues.rawBody=JSON.stringify([{leagueid:'300',tier:'amateur'}]);f.archive.leagues.bodySha256=sourceSha(f.archive.leagues.rawBody);}
  else {const p=JSON.parse(receipt.rawBody);if(change==='missing_winner')delete p.radiant_win;else p.duration=100000000;receipt.rawBody=JSON.stringify(p);receipt.bodySha256=receipt.originalPayloadSha256=sourceSha(receipt.rawBody);}
  const r=run(f);assert.equal(r.features.pairedMaps,0);assert(r.sourceLedger.rows.some(r=>r.status==='unavailable'));
 }
});
test('missing receipt is a visible unavailable row, not a smaller sample',()=>{
 const f=sourceFixture();f.archive.receipts=f.archive.receipts.filter(r=>r.matchId!==f.input.cases[0].target.matchId);
 const r=run(f);assert.equal(r.features.denominator,2);assert.equal(r.features.pairedMaps,0);assert.equal(r.labels.rows.length,1);
 assert(r.sourceLedger.rows[0].reasons.includes('TARGET_SOURCE_MISSING'));
});
test('body/endpoint/hash tampering and duplicate source records fail closed',()=>{
 for(const mutate of [f=>f.archive.receipts[0].rawBody+=' ',f=>f.archive.receipts[0].endpoint='/matches/1',
  f=>f.archive.receipts[0].originalPayloadSha256='b'.repeat(64),f=>f.archive.receipts.push(f.archive.receipts[0]),
  f=>f.archive.leagues.rawBody+=' ',f=>f.archive.teams.push(f.archive.teams[0])]){const f=sourceFixture();mutate(f);assert.throws(()=>run(f));}
});
test('stored projection retains both hashes without asserting retained HTTP bytes',()=>{
 const f=sourceFixture();f.archive.receipts[0].kind='stored_projection';f.archive.receipts[0].originalPayloadSha256='b'.repeat(64);bindFixture(f);
 const r=run(f);assert.equal(r.features.pairedMaps,2);assert.equal(r.sourceLedger.retainedProjections,1);assert.equal(r.sourceLedger.retainedRawResponses,7);
});
test('unknown historical hero remains null; no draft timeline or role is inferred',()=>{
 const f=sourceFixture(),r=f.archive.receipts[0],p=JSON.parse(r.rawBody);p.players[0].hero_id=0;r.rawBody=JSON.stringify(p);bindFixture(f);
 const result=run(f);assert.equal(result.features.pairedMaps,2);assert(result.features.rows[0].feature.heroSnapshot.warnings.includes('HERO_HISTORY_INCOMPLETE'));
});
test('conflicting identities and duplicate slots cannot create a valid map',()=>{
 const f=sourceFixture();f.archive.identities.push({...f.archive.identities[0],observationId:'conflict',playerId:'999'});
 assert(inspectConditionalSources(f.archive).rows.every(r=>r.target===null));
 const g=sourceFixture(),r=g.archive.receipts[0],p=JSON.parse(r.rawBody);p.players[0].player_slot=1;r.rawBody=JSON.stringify(p);r.bodySha256=r.originalPayloadSha256=sourceSha(r.rawBody);
 assert(inspectConditionalSources(g.archive).rows[0].reasons.includes('PLAYER_SLOTS_OR_IDENTITIES_INVALID'));
});
test('excluded cases still reject their own outcome in history before source filtering',()=>{
 const f=sourceFixture();f.input.exposure.mapIds.push(f.input.cases[0].target.matchId);
 f.input.cases[0].history.maps[0].matchId=f.input.cases[0].target.matchId;
 assert.throws(()=>run(f),/target_outcome_forbidden/);
});
test('omitting an available historical map cannot silently change the fixed source universe',()=>{
 const f=sourceFixture();f.input.cases[0].history.maps.pop();f.input.cases[0].heroHistory.maps.pop();
 const r=run(f);assert.equal(r.features.pairedMaps,0);assert(r.sourceLedger.rows[0].reasons.includes('HISTORY_UNIVERSE_MISMATCH'));
});
