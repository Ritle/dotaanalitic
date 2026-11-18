import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sha} from '../../tools/research/exposure-ledger-core.mjs';
import {archiveSourceProjections} from '../../tools/research/exposure-archive-sources.mjs';
const receipt=(records,endpoint='/teams/1/matches')=>{
 const rawBody=JSON.stringify(records);return {rawBody,source:{provider:'opendota',endpoint,payloadSha256:sha(rawBody)}};
};
test('nested team histories bind raw hashes and deduplicate repeated maps',()=>{
 const r=archiveSourceProjections({discoveries:[receipt([{match_id:10,series_id:3},{match_id:10,series_id:3}])]});
 assert.equal(r.sources.length,1);assert.equal(r.sources[0].rows.length,1);assert.equal(r.sources[0].pointer,'/discoveries/0');
});
test('hash or endpoint mismatch cannot add any map',()=>{
 const x=receipt([{match_id:10}]);x.rawBody='[]';
 assert.equal(archiveSourceProjections(x).issues.length,1);
 const y=receipt({match_id:10},'/matches/11');
 assert.equal(archiveSourceProjections(y).sources.length,0);
});
test('legacy discovery needs explicit manifest binding; namespace cannot be guessed from endpoint',()=>{
 const r=receipt([{match_id:10}],'/leagues/1/matches');
 const x={status:'captured',endpoint:r.source.endpoint,payloadSha256:r.source.payloadSha256,rawBody:r.rawBody};
 assert.equal(archiveSourceProjections(x).sources.length,0);
 assert.equal(archiveSourceProjections(x,{legacyDiscoveryBound:true}).sources.length,1);
});
const e=id=>({endpoint:'/matches/'+id,adapter_version:'opendota-provider-v2',payload_sha256:'a'.repeat(64),fetched_at:'2026-11-01T00:00:00Z'});
test('normalized live audit proves prior observation, not raw-byte or training validity',()=>{
 const r=archiveSourceProjections({mode:'live_opendota',observations:[{match_id:'10',source_evidence:e('10')}]});
 assert.equal(r.sources[0].basis,'observed_live_opendota_audit_report_not_raw');
 assert.equal(r.sources[0].rows[0].seriesKey,null);
 const bad=archiveSourceProjections({mode:'offline_fixture',observations:[{match_id:'10',source_evidence:e('10')}]});
 assert.equal(bad.sources.length,0);
});
test('synthetic snapshots and unsupported player ranked endpoints cannot add exposure sources',()=>{
 assert.equal(archiveSourceProjections({syntheticOnly:true,...receipt([{match_id:10}])}).sources.length,0);
 assert.equal(archiveSourceProjections(receipt([{match_id:10}],'/players/1/matches')).sources.length,0);
});
test('live league report requires the native league endpoint and preserves series',()=>{
 const x={mode:'live_opendota',cohorts:[{league_id:'1',source_evidence:{...e('10'),endpoint:'/leagues/1/matches'},matches:[{match_id:'10',series_id:'3'}]}]};
 assert.equal(archiveSourceProjections(x).sources[0].rows[0].seriesKey,'["opendota","3"]');
 x.cohorts[0].source_evidence.endpoint='/leagues/2/matches';
 assert.equal(archiveSourceProjections(x).sources.length,0);
});
