import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExposureLedger,extractExposure,screenExposure,id,seriesKey,sha} from '../../tools/research/exposure-ledger-core.mjs';
const key=x=>JSON.stringify(['opendota',x]);
const row=(matchId,series='1',alias=null)=>({matchId,seriesKey:series===null?null:key(series),localSeriesId:alias});
const source=(path,rows)=>({path,sha256:'a'.repeat(64),adapter:'synthetic_unit_only',rows,standaloneSeriesKeys:[]});
const input=sources=>({format:'exposure-ledger-input-v1',capturedAt:'2026-11-14T00:00:00.000Z',sources,pendingReview:['raw sources']});
test('deduplicates maps across files and retains every source, no training admission',()=>{
 const result=buildExposureLedger(input([source('a',[row('10')]),source('b',[row('10'),row('11')])]));
 assert.equal(result.summary.maps,2);assert.equal(result.maps[0].evidence.length,2);assert.equal(result.summary.knownSeries,1);
 assert.equal(result.deployable,false);assert.equal(result.completeGlobalInventory,false);
});
test('unseen map of exposed series is excluded',()=>{
 const r=buildExposureLedger(input([source('a',[row('10')])]));
 assert.equal(screenExposure(r,{matchId:'12',seriesKey:key('1')}).status,'excluded');
 assert.equal(screenExposure(r,{matchId:'12',seriesKey:key('2')}).status,'unresolved');
 assert.equal(screenExposure(r,{matchId:'10',seriesKey:null}).status,'excluded');
 assert.equal(screenExposure(r,{matchId:'12',seriesKey:null}).independent,false);
});
test('conflicting aliases and native keys are preserved without merging or last-write wins',()=>{
 const r=buildExposureLedger(input([source('a',[row('10','1','local')]),source('b',[row('10','2','local'),row('11',null,'local')])]));
 assert.deepEqual(r.conflictingMapIds,['10']);assert.deepEqual(r.conflictingLocalAliases,['local']);
 assert.deepEqual(r.canonicalSeriesKeys,[key('1'),key('2')]);assert.deepEqual(r.unresolvedMapIds,['11']);
 assert.equal(r.maps[1].seriesKeys.length,0);
});
test('unknown stays unknown; unrelated foreign namespace is not canonical',()=>{
 const r=extractExposure('database',{format:'exposure-database-snapshot-v1',readOnly:true,
 maps:[{matchId:'10',provider:'pandascore',providerSeriesId:'1',localSeriesId:'l'}]});
 assert.equal(r.rows[0].seriesKey,null);
 assert.throws(()=>seriesKey(JSON.stringify(['pandascore','1'])));
});
test('decimal IDs preserve bigints and reject zero, unsafe numbers and overflow',()=>{
 assert.equal(id('9007199254740993'),'9007199254740993');
 for(const x of [9007199254740993,'0','01','-1','9223372036854775808'])assert.throws(()=>id(x));
});
test('duplicate maps within source and duplicate sources fail',()=>{
 assert.throws(()=>buildExposureLedger(input([source('a',[row('10'),row('10')])])),/duplicate_map/);
 assert.throws(()=>buildExposureLedger(input([source('a',[]),source('a',[])])),/duplicate_source/);
});
test('V1 source requires matched alias and excludes no candidate merely for ineligibility',()=>{
 const data={format:'v1-development-dataset-v1',source:{syntheticOnly:false,
 aliases:[{seriesId:'a',provider:'opendota',providerSeriesId:'2'}],
 candidates:[{matchId:'10',seriesId:'a',seriesSourceMatched:true,isPro:false},
 {matchId:'11',seriesId:'a',seriesSourceMatched:false}]}};
 const r=extractExposure('v1-source',data);assert.equal(r.rows.length,2);assert.equal(r.rows[0].seriesKey,key('2'));
 assert.equal(r.rows[1].seriesKey,null);assert.equal(r.rows[1].localSeriesId,'a');
});
test('synthetic artifacts, unknown formats and untyped ID arrays cannot enter source adapters',()=>{
 assert.throws(()=>extractExposure('post-draft-rows',{format:'conditional-post-draft-dataset-v1',syntheticOnly:true,rows:[]}),/synthetic/);
 assert.throws(()=>extractExposure('post-draft-rows',{format:'unknown',syntheticOnly:false,rows:[]}),/source_format/);
 assert.throws(()=>extractExposure('metadata',[{id:'10'}]));
});
test('prior exposed series without rows are retained',()=>{
 const s=source('a',[row('10',null)]);s.standaloneSeriesKeys=[key('99')];
 const r=buildExposureLedger(input([s]));assert.deepEqual(r.canonicalSeriesKeys,[key('99')]);
 assert.deepEqual(r.unresolvedMapIds,['10']);assert.equal(r.maps[0].seriesKeys.length,0);
});
test('deterministic union is independent of source order and never mutates input',()=>{
 const x=input([source('b',[row('10','1','l')]),source('a',[row('11','2','m')])]),copy=structuredClone(x);
 const a=buildExposureLedger(x),b=buildExposureLedger({...x,sources:[...x.sources].reverse()});
 assert.deepEqual(a,b);assert.deepEqual(x,copy);
});
test('native discovery cannot treat PandaScore series IDs as OpenDota',()=>{
 assert.throws(()=>extractExposure('opendota-discovery-ledger',{sources:[{provider:'pandascore'}],ledger:[{matchId:'10',seriesId:'1'}]}),/discovery_namespace/);
 assert.equal(extractExposure('opendota-discovery-ledger',{sources:[{provider:'opendota'}],ledger:[{matchId:'10',seriesId:'0'}]}).rows[0].seriesKey,null);
});
const receipt=(body,endpoint='/explorer?sql=fixed')=>{
 const rawBody=JSON.stringify(body);return {rawBody,source:{provider:'opendota',endpoint,payloadSha256:sha(rawBody)}};
};
test('raw source SHA, native endpoint binding and safe numeric IDs are mandatory',()=>{
 const x=receipt({match_id:10,series_id:1},'/matches/10');
 assert.equal(extractExposure('opendota-receipt',x).rows[0].seriesKey,key('1'));
 assert.throws(()=>extractExposure('opendota-receipt',{...x,rawBody:'{}'}),/raw_body_sha/);
 assert.throws(()=>extractExposure('opendota-receipt',receipt({match_id:10},'/matches/11')),/detail_map_mismatch/);
 assert.throws(()=>extractExposure('opendota-receipt',receipt([{match_id:9007199254740992}],'/proMatches')),/unsafe_numeric_id/);
});
test('explorer player rows count one map; errors or contradictory series fail',()=>{
 const x=receipt({err:null,rows:[{match_id:'10',account_id:'1'},{match_id:'10',account_id:'2'}]});
 assert.equal(extractExposure('opendota-receipt',{observation:x}).rows.length,1);
 assert.throws(()=>extractExposure('opendota-receipt',receipt({err:'failure',rows:[]})),/explorer_error/);
 assert.throws(()=>extractExposure('opendota-receipt',receipt([{match_id:10,series_id:1},{match_id:10,series_id:2}],'/proMatches')),/conflicting_receipt_series/);
});
