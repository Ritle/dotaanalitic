import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {selectAuditMaps,coverage,safeAuditError,buildAuditReport} from '../../scripts/lib/coverage-audit.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));

test('historical ranks are deterministic, deduplicate mixed IDs and preserve bigint precision',()=>{
  const discovery=[5,3,1,4,2].map(i=>({match_id:String(9007199254740990n+BigInt(i)),start_time:i,leagueid:'77'}));
  discovery.push({...discovery[0]}, {match_id:'1',leagueid:'78'}, {match_id:0});
  const result=selectAuditMaps(discovery,3,'77');
  assert.deepEqual(result.selected.map(x=>x.start_time),[1,3,5]);
  assert.equal(result.selected[2].match_id,'9007199254740995');
  assert.equal(result.duplicates,1);assert.equal(result.invalid,1);assert.equal(result.outsideCohort,1);
  assert.deepEqual(selectAuditMaps([...discovery].reverse(),3,'77').selected,result.selected);
});
test('recent selection keeps discovery order and small cohorts do not manufacture missing maps',()=>{
  const discovery=[3,1,2].map(match_id=>({match_id}));
  assert.deepEqual(selectAuditMaps(discovery,2).selected.map(x=>x.match_id),['3','1']);
  assert.equal(selectAuditMaps(discovery,50).selected.length,3);
});
test('unknown validation is unassessed with a nullable rate, never a failed or passed validation',()=>{
  const rows=[{match_id:'1',flags:{identity_10:true,draft_order_valid:null}},
    {match_id:'2',flags:{identity_10:false,draft_order_valid:null}}];
  assert.equal(coverage(rows).identity_10.ratio,0.5);
  assert.deepEqual(coverage(rows).draft_order_valid,{count:0,of:0,ratio:null,missing_match_ids:[],not_assessed_match_ids:['1','2']});
  assert.equal(coverage([]).identity_10.ratio,null);
});
test('pro coverage excludes unclassified/false maps and report accounts for partial discovery',()=>{
  const rows=[true,null,false].map((pro,i)=>({match_id:String(i+1),flags:{confirmed_pro:pro,identity_10:i===0},anomalies:[],started_at:null}));
  const report=buildAuditReport({mode:'synthetic_fixture',requested:4,selection:selectAuditMaps(rows,4),rows,errors:[],
    requests:{attempts:0},sourceEvidence:[],leagueId:null,generatedAt:'2026-01-01T00:00:00Z'});
  assert.equal(report.status,'partial');assert.equal(report.coverage.identity_10.of,3);
  assert.equal(report.confirmed_pro_coverage.identity_10.of,1);
  assert.equal(report.confirmed_pro_coverage.identity_10.ratio,1);
});
test('safe failures keep status/retry timing but discard paths, URLs and credential text',()=>{
  const failure=safeAuditError({code:'source_rate_limited',status:429,retryAfterMs:60000,message:'secret',url:'https://secret'},'1');
  assert.deepEqual(failure,{match_id:'1',code:'source_rate_limited',status:429,retry_after_ms:60000});
  assert.equal(JSON.stringify(failure).includes('secret'),false);
});
test('CLI fixture mode stays synthetic and offline; failed discovery still writes a blocked report',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dota-audit-test-'));
  try {
    const output=join(dir,'report.json'),cli='scripts/audit-prediction-sources.mjs';
    const env={...process.env,DATABASE_URL:'invalid-offline-sentinel',OPENDOTA_API_KEY:'secret-offline-sentinel'};
    const successful=spawnSync(process.execPath,[cli,'--fixture','tests/fixtures/opendota-audit-anomalies-synthetic.json','--sample','6','--out',output],{cwd:root,env,encoding:'utf8'});
    assert.equal(successful.status,0,successful.stderr);
    const report=JSON.parse(await readFile(output,'utf8'));
    assert.equal(report.mode,'synthetic_fixture');assert.equal(report.requests.attempts,0);
    assert.equal(report.coverage.confirmed_pro.of,0);assert.equal(report.observations.length,6);
    assert.equal(successful.stdout.includes('secret-offline-sentinel'),false);
    assert.equal(successful.stdout.includes('account_id'),false);
    const failed=spawnSync(process.execPath,[cli,'--fixture','tests/fixtures/does-not-exist.json','--out',output],{cwd:root,env,encoding:'utf8'});
    assert.equal(failed.status,1);assert.equal(JSON.parse(await readFile(output,'utf8')).status,'blocked');
    assert.equal(failed.stdout.includes('secret-offline-sentinel'),false);
  } finally {
    assert.equal(dirname(resolve(dir)),resolve(tmpdir()));
    assert.match(basename(dir),/^dota-audit-test-[a-zA-Z0-9]+$/);
    await rm(dir,{recursive:true,force:true});
  }
});
