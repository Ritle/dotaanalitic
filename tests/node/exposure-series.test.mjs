import test from 'node:test';
import assert from 'node:assert/strict';
import {sha,buildExposureLedger,screenExposure} from '../../tools/research/exposure-ledger-core.mjs';
import {detailSeriesProjection,leagueLastSeriesProjection,restoreBaselineSources,extendSeries} from '../../tools/research/exposure-series-core.mjs';
import {seriesArtifactPath,verifySeries} from '../../tools/research/exposure-series.mjs';
const h='a'.repeat(64),stamp='2026-11-15T00:00:00.000Z',key=n=>JSON.stringify(['opendota',n]);
const receipt=()=>{const projection={match_id:10,series_id:20};return {matchId:'10',status:'observed',receipt:{source:{provider:'opendota',endpoint:'/matches/10',payloadSha256:h,fetchedAt:stamp,knownAt:null},projection,projectionSha256:sha(JSON.stringify(projection)),sourceIssues:[],originalResponseBytesRetained:false,basis:'validated_http_projected'}};};
const src=(path,rows)=>({path,sha256:h,adapter:'synthetic_test',rows,standaloneSeriesKeys:[]});
const row=(matchId,seriesKey=null)=>({matchId,seriesKey,localSeriesId:null});
const build=sources=>buildExposureLedger({format:'exposure-ledger-input-v1',capturedAt:stamp,sources,pendingReview:[]});
test('projection has its own hash and cannot masquerade as reverified raw HTTP bytes',()=>{
 const x=receipt(),r=detailSeriesProjection(x);assert.equal(r.row.seriesKey,key('20'));assert.equal(r.provenance.originalResponseBytesRetained,false);
 x.receipt.projection.series_id=21;assert.throws(()=>detailSeriesProjection(x),/projection_sha/);
});
test('provider, endpoint, map, unsafe ID, unknown series and source issues fail closed',()=>{
 for(const mutate of [x=>x.receipt.source.provider='valve',x=>x.receipt.source.endpoint='/matches/11',x=>x.matchId='11',
  x=>x.receipt.sourceIssues=['SERIES_INVALID'],x=>x.receipt.originalResponseBytesRetained=true]){
  const x=receipt();mutate(x);assert.throws(()=>detailSeriesProjection(x));}
 for(const id of [0,null,9007199254740992]){const x=receipt();x.receipt.projection.series_id=id;x.receipt.projectionSha256=sha(JSON.stringify(x.receipt.projection));assert.throws(()=>detailSeriesProjection(x));}
});
test('league last-row binding requires source endpoint and league agreement, stays normalized',()=>{
 const x={leagues:[{leagueId:'20486',source:{provider:'opendota',endpoint:'/leagues/20486/matches',payloadSha256:h,fetchedAt:stamp},last:{match_id:'10',series_id:'20',leagueid:'20486'}}]};
 assert.equal(leagueLastSeriesProjection(x).provenance.projectionSha256,null);
 x.leagues[0].last.leagueid='1';assert.throws(()=>leagueLastSeriesProjection(x),/league_binding/);
});
test('reconstructed source rows must reproduce the entire baseline including provenance',()=>{
 const inherited=[src('parent',[row('10')])],extra=src('new',[row('11',key('21'))]),ledger=build([...inherited,extra]);
 assert.deepEqual(build(restoreBaselineSources(ledger,inherited)),ledger);
 const wrong=structuredClone(ledger);wrong.maps[1].evidence[0].row=3;assert.throws(()=>restoreBaselineSources(wrong,inherited),/parent_row/);
});
test('new series excludes a different map in that series without adding training maps or opening admission',()=>{
 const sources=[src('parent',[row('10')])],ledger=build(sources),p=detailSeriesProjection(receipt());
 const r=extendSeries(ledger,sources,[{...p,path:'receipt',sha256:h}],['20'],stamp);
 assert.equal(r.ledger.summary.maps,1);assert.equal(r.ledger.summary.knownSeries,1);assert.equal(r.ledger.summary.unresolvedMaps,0);
 assert.equal(screenExposure(r.ledger,{matchId:'11',seriesKey:key('20')}).status,'excluded');
 assert.equal(r.registrationAllowed,false);assert.equal(ledger.summary.knownSeries,0);
});
test('conflicts preserve both exclusion keys; duplicates and unseen maps do not silently extend scope',()=>{
 const sources=[src('parent',[row('10',key('19'))])],ledger=build(sources),p={...detailSeriesProjection(receipt()),path:'receipt',sha256:h};
 const r=extendSeries(ledger,sources,[p],['20'],stamp);assert.equal(r.ledger.summary.conflictingMaps,1);
 assert.deepEqual(r.ledger.maps[0].seriesKeys,[key('19'),key('20')]);
 assert.throws(()=>extendSeries(ledger,sources,[p],['20','21'],stamp),/incomplete_series_queue/);
 assert.throws(()=>extendSeries(ledger,sources,[p,p],['20'],stamp),/duplicate_source/);
 assert.throws(()=>extendSeries(ledger,sources,[{...p,row:row('99',key('20'))}],['20'],stamp),/unreviewed_map/);
});
test('file boundary rejects secret/escaped/public paths and missing external digest',async()=>{
 for(const p of ['../outside.json','.tools/private-owner/access.json','.env'])assert.throws(()=>seriesArtifactPath(p));
 assert.throws(()=>seriesArtifactPath('docs/evidence/output.json',true));
 await assert.rejects(verifySeries('.tools/no-file.json'),/external_sha_required/);
});
