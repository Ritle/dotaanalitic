import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rankedArchiveIds,syntheticArchive} from '../../tools/research/exposure-archive-triage.mjs';
import {sha} from '../../tools/research/exposure-ledger-core.mjs';
const fixture=rows=>{const b=JSON.stringify(rows);return {rawBodies:[b],observation:{provider:'opendota',filters:{lobbyTypeId:7},receipts:[{payloadSha256:sha(b)}]}};};
test('ranked identity requires raw lobby type and bound receipt digest, counts maps once',()=>{
 assert.deepEqual(rankedArchiveIds(fixture([{match_id:10,lobby_type:7},{match_id:10,lobby_type:7}])),['10']);
 assert.throws(()=>rankedArchiveIds(fixture([{match_id:10,lobby_type:1}])),/raw_lobby_type/);
 const x=fixture([{match_id:10,lobby_type:7}]);x.rawBodies[0]='[]';assert.throws(()=>rankedArchiveIds(x),/ranked_sha/);
});
test('provider/filter declarations alone and unsafe numeric IDs are insufficient',()=>{
 const x=fixture([]);x.observation.provider='pandascore';assert.throws(()=>rankedArchiveIds(x),/ranked_filter/);
 assert.throws(()=>rankedArchiveIds(fixture([{match_id:9007199254740992,lobby_type:7}])),/unsafe_ranked_id/);
});
test('synthetic exclusion requires every case and both capture/history flags',()=>{
 const input={format:'player-hero-prospective-features-input-v1',capture:{syntheticOnly:true},history:{syntheticOnly:true}};
 assert.equal(syntheticArchive(input),true);assert.equal(syntheticArchive([{input},{input}]),true);
 assert.equal(syntheticArchive([{input},{input:{...input,history:{syntheticOnly:false}}}]),false);
 assert.equal(syntheticArchive([]),false);assert.equal(syntheticArchive({syntheticOnly:true}),false);
});
