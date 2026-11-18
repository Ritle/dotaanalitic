import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewArchive,compactReview,summarizeArchiveReviews} from '../../tools/research/exposure-archive-core.mjs';
const baseline={mapIds:['10','9007199254740993'],canonicalSeriesKeys:['["opendota","3"]'],aliases:[{localSeriesId:'local-three'}]};
test('covers repeated import references without inventing training samples',()=>{
 const r=reviewArchive({results:[{matchId:'10'},{matchId:'10'}],seriesId:'local-three'},baseline);
 assert.equal(r.summary.references,3);assert.equal(r.status,'references_covered_or_foreign');assert.deepEqual(r.novelMapIds,[]);
});
test('unknown numerical ID stays untyped until namespace evidence exists',()=>{
 const r=reviewArchive({matchId:'11'},baseline);
 assert.equal(r.references[0].status,'novel_untyped_reference');assert.equal(r.admissionAllowed,false);
 assert.equal(reviewArchive({source:{provider:'opendota'},matchId:'11'},baseline).references[0].status,'novel_explicit_native_reference');
});
test('PandaScore match IDs do not become native maps and nested provider overrides parent',()=>{
 const r=reviewArchive({provider:'opendota',rows:[{provider:'pandascore',matchId:'11'}]},baseline);
 assert.deepEqual(r.novelMapIds,[]);assert.equal(r.summary.foreignReferences,1);
});
test('STRATZ series IDs never use OpenDota alias merely by equal number',()=>{
 const r=reviewArchive({provider:'stratz',seriesId:'3'},baseline);
 assert.equal(r.references[0].status,'novel_untyped_reference');
});
test('parses embedded source JSON and distinguishes malformed text from no evidence',()=>{
 assert.deepEqual(reviewArchive({sourceText:JSON.stringify({match_id:'11'})},baseline).novelMapIds,['11']);
 const r=reviewArchive({record:'{broken'},baseline);assert.equal(r.status,'requires_review');assert.equal(r.opaque.length,1);
});
test('synthetic subtrees are excluded without hiding real sibling references',()=>{
 const r=reviewArchive({fixture:{syntheticOnly:true,matchId:'1'},real:{matchId:'11'}},baseline);
 assert.deepEqual(r.novelMapIds,['11']);assert.deepEqual(r.syntheticPaths,['/fixture']);
});
test('generic IDs, nicknames, counters and empty data never establish native identity',()=>{
 const r=reviewArchive({id:'11',nickname:'11',maps:11},baseline);
 assert.equal(r.status,'no_explicit_references');assert.equal(r.completeGlobalInventory,false);
});
test('bigint string stays exact; unsafe number becomes unresolved, not rounded map ID',()=>{
 assert.equal(reviewArchive({matchId:'9007199254740993'},baseline).summary.coveredReferences,1);
 const r=reviewArchive({matchId:9007199254740992},baseline);assert.equal(r.opaque.length,1);assert.deepEqual(r.novelMapIds,[]);
});
test('canonical series keys and lists retain unknown keys separately from map IDs',()=>{
 const r=reviewArchive({seriesKeys:['["opendota","3"]','["opendota","4"]'],mapIds:['10','11']},baseline);
 assert.deepEqual(r.novelNativeSeriesKeys,['["opendota","4"]']);assert.deepEqual(r.novelMapIds,['11']);
});
test('resource limits fail explicitly including nested JSON strings',()=>{
 assert.throws(()=>reviewArchive({a:{b:1}},baseline,{maxDepth:1}),/depth_limit/);
 assert.throws(()=>reviewArchive({a:[1,2,3]},baseline,{maxNodes:2}),/node_limit/);
 assert.throws(()=>reviewArchive({a:'{"matchId":"11"}'},baseline,{maxEmbeddedBytes:2}),/embedded_byte_limit/);
});
test('compact review preserves novel evidence and binds all references without modifying inputs',()=>{
 const x={rows:[{matchId:'10'},{matchId:'11'}]},copy=structuredClone(x),r=reviewArchive(x,baseline),c=compactReview(r);
 assert.equal(c.references.length,1);assert.equal(c.summary.references,2);assert.match(c.referenceFingerprint,/^[a-f0-9]{64}$/);
 assert.deepEqual(x,copy);assert.deepEqual(compactReview(reviewArchive(x,baseline)),c);
 assert.deepEqual(summarizeArchiveReviews([{path:'a',sha256:'a'.repeat(64),review:c}]).novelMapIds,['11']);
});
test('legacy OpenDota series keys and snake-case map lists are explicitly supported',()=>{
 const r=reviewArchive({providerSeriesKey:'opendota:3',seriesKey:'opendota:4',match_ids:['10','11']},baseline);
 assert.deepEqual(r.novelNativeSeriesKeys,['["opendota","4"]']);assert.deepEqual(r.novelMapIds,['11']);assert.equal(r.opaque.length,0);
});
test('display names are not encoded observations; explicit native fields under foreign providers remain reviewable',()=>{
 const r=reviewArchive({provider:'pandascore',name:'{not json',nativeMatchId:'11'},baseline);
 assert.equal(r.opaque.length,0);assert.deepEqual(r.novelMapIds,['11']);assert.equal(r.references[0].provider,null);
});
