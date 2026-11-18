import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeArchive,auditValveSeries,auditCoverageFile} from '../../tools/research/exposure-coverage-core.mjs';
import {safeCoveragePath,verifyCoverage} from '../../tools/research/exposure-coverage.mjs';
const key=n=>JSON.stringify(['opendota',n]);
const ledger={maps:[{matchId:'10',seriesKeys:[key('100')]},{matchId:'11',seriesKeys:[]}],mapIds:['10','11'],canonicalSeriesKeys:[key('100')],aliases:[]};
const valve=(seriesId,mapIds)=>({provider:'valve',providerSeriesId:seriesId,mapIds,source:{path:'synthetic',sha256:'a'.repeat(64)}});
test('UTF16 JSON is decoded without altering bytes; authorization and malformed payloads stay distinct',()=>{
 const b=Buffer.concat([Buffer.from([255,254]),Buffer.from('{"matchId":"10"}','utf16le')]),copy=Buffer.from(b);
 assert.equal(decodeArchive(b).value.matchId,'10');assert.deepEqual(b,copy);
 assert.equal(decodeArchive(Buffer.from('Unauthorized')).kind,'authorization_error_no_payload');
 assert.equal(decodeArchive(Buffer.from('Unauthorized {"matchId":12}')).kind,'unparsed');
 assert.throws(()=>decodeArchive(Buffer.from([255,254,1])),/invalid_utf16/);
});
test('Valve numeric equality never creates an alias; only observed common maps produce diagnostic agreement',()=>{
 const r=auditValveSeries([valve('100',['11']),valve('9',['10']),valve('8',['10','11'])],ledger);
 assert.deepEqual(r.groups.map(g=>g.status),['no_opendota_link','all_maps_agree','partial_map_agreement']);
 assert.equal(r.canonicalAliasesCreated,0);assert.equal(r.reverseConflicts.length,1);
});
test('conflicting and missing map evidence remain explicit, empty series is unknown',()=>{
 const l={...ledger,maps:[...ledger.maps,{matchId:'12',seriesKeys:[key('101')]}]};
 const r=auditValveSeries([valve('1',['10','12']),valve('2',['99']),valve('3',[])],l);
 assert.equal(r.counts.conflicting_map_evidence,1);assert.equal(r.counts.no_opendota_link,2);
 assert.deepEqual(r.missingValveMapIds,['99']);assert.throws(()=>auditValveSeries([valve('2',['10','10'])],l),/duplicate_valve_map/);
});
test('new namespace evidence accounts for PandaScore but cannot relabel explicit OpenDota fields',()=>{
 const ns={decisions:[{value:'12',namespace:'pandascore_match'}]},triage={decisions:[]};
 const r=auditCoverageFile(Buffer.from('{"matchId":"12"}'),ledger,triage,ns);
 assert.equal(r.status,'scoped_references_accounted');
 const wrong=auditCoverageFile(Buffer.from('{"provider":"opendota","matchId":"12"}'),ledger,triage,ns);
 assert.equal(wrong.status,'requires_review');
});
test('ranked references do not become pro maps; synthetic numbers do not hide real occurrences',()=>{
 const triage={decisions:[{matchId:'12',status:'native_ranked_evidence'},{matchId:'13',status:'only_verified_synthetic_sources'}]};
 const r=auditCoverageFile(Buffer.from('{"mapIds":["12","13"]}'),ledger,triage,{decisions:[]});
 assert.equal(r.referenceCounts.ranked_reference_not_pro,1);assert.equal(r.unresolvedReferences[0].value,'13');
});
test('opaque text, unknown references and resource limits cannot become proof of completeness',()=>{
 const b=Buffer.from('{"payload":"[not json","matchId":"99"}');
 assert.equal(auditCoverageFile(b,ledger,{decisions:[]},{decisions:[]}).status,'requires_review');
 assert.equal(auditCoverageFile(b,ledger,{decisions:[]},{decisions:[]},{maxNodes:1}).status,'resource_limit');
});
test('private inputs, path escapes and public outputs are rejected; external SHA is required',async()=>{
 for(const p of ['.tools/private-owner/access.json','../outside.json','.env'])assert.throws(()=>safeCoveragePath(p));
 assert.throws(()=>safeCoveragePath('docs/evidence/result.json',true));
 await assert.rejects(verifyCoverage('.tools/missing.json'),/external_sha_required/);
});
