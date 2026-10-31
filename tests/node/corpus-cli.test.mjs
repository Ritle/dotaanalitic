// SYNTHETIC transport fixtures only. The live_opendota envelope exercises the
// parser; synthetic adapter markers and isolated temp files never train a model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const script=join(root,'scripts/analyze-corpus.mjs');
const request={stage:'pre_match',teamASide:'radiant',fromAt:'2024-01-01T00:00:00.000Z',
  trainUntil:'2024-02-01T00:00:00.000Z',calibrationUntil:'2024-03-01T00:00:00.000Z',
  validationUntil:'2024-04-01T00:00:00.000Z',toAt:'2024-05-01T00:00:00.000Z',
  snapshotAt:'2026-02-01T00:00:00.000Z',maxMaps:1000};
const evidence=(endpoint='/leagues/77/matches')=>({endpoint,fetched_at:'2026-01-01T00:00:00.000Z',
  payload_sha256:'a'.repeat(64),adapter_version:'synthetic-corpus-cli-fixture'});
const match=()=>({match_id:'9007199254740993',start_time:1704153600,duration:1800,radiant_win:true,
  radiant_team_id:'11',dire_team_id:'22',leagueid:'77',series_id:'88',series_type:1});
const discovery=(matches=[])=>({schema_version:1,mode:'live_opendota',generated_at:'2026-01-02T00:00:00.000Z',
  selection_catalog:{source_evidence:evidence('/leagues')},errors:[],
  cohorts:[{league_id:'77',name:'SYNTHETIC CLI fixture',tier:'professional',endpoint_completeness:'unknown',
    series_membership_completeness:'unknown',source_evidence:evidence(),matches}]});
const detail=()=>({schema_version:3,mode:'live_opendota',status:'complete',generated_at:'2026-01-02T00:00:00.000Z',
  source_evidence:[evidence('/leagues')],observations:[{match_id:match().match_id,
    started_at:new Date(match().start_time*1000).toISOString(),league_id:'77',provider_patch_id:1,
    flags:{confirmed_pro:true,match_id_consistent:true,completed_outcome:true,teams_2:true,series:true,
      identity_10:true,heroes_10_unique:true,patch:true,pre_match_lineup_known_at:true},
    source_evidence:evidence('/matches/'+match().match_id)}]});

async function workspace(work){
  const directory=await mkdtemp(join(tmpdir(),'dota-corpus-cli-test-')),files=new Set();
  const path=name=>{assert.match(name,/^[a-z0-9-]+\.json$/);files.add(name);return join(directory,name);};
  const capture=async(name,body,kind='discovery')=>{
    const content=JSON.stringify(body)+'\n';await writeFile(path(name),content,'utf8');
    return {kind,path:name,sha256:createHash('sha256').update(content).digest('hex')};
  };
  const invoke=async(captures,outputName='report.json')=>{
    const input=path('config.json'),output=path(outputName);
    await writeFile(input,JSON.stringify({schemaVersion:1,request,captures}),'utf8');
    const result=spawnSync(process.execPath,[script,input,output],{cwd:root,encoding:'utf8',timeout:15000,windowsHide:true,
      env:{...process.env,DATABASE_URL:'invalid-offline-corpus-sentinel',OPENDOTA_API_KEY:'secret-offline-corpus-sentinel'}});
    assert.equal(result.error,undefined);
    assert.ok(!(result.stdout+result.stderr).includes('secret-offline-corpus-sentinel'));
    assert.ok(!(result.stdout+result.stderr).includes('invalid-offline-corpus-sentinel'));
    return {...result,output};
  };
  try {await work({capture,invoke,path});}
  finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    assert.match(basename(directory),/^dota-corpus-cli-test-[a-zA-Z0-9]+$/);
    for(const name of files) await unlink(join(directory,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await rmdir(directory);
  }
}

test('corpus CLI reports an empty observed corpus as unavailable with nullable coverage and no eligibility',async()=>{
  await workspace(async({capture,invoke})=>{
    const result=await invoke([await capture('discovery.json',discovery())]);
    assert.equal(result.status,3,result.stderr);
    const summary=JSON.parse(result.stdout),report=JSON.parse(await readFile(result.output,'utf8'));
    assert.equal(summary.uniqueMaps,0);assert.equal(summary.status,'unavailable');
    assert.equal(summary.strictHistoricalEligibility,'not_assessed');
    assert.equal(summary.trainingReady,false);assert.equal(summary.deployable,false);
    assert.equal(report.detailCoverage.identity_10.ratio,null);
    assert.equal(report.detailCoverage.identity_10.assessed,0);
    assert.deepEqual(report.maps,[]);assert.deepEqual(report.bySplit,{});
  });
});

test('corpus CLI deduplicates maps and repeated captures without converting source flags into training eligibility',async()=>{
  await workspace(async({capture,invoke})=>{
    const source=await capture('discovery.json',discovery([match(),match()]));
    const details=await capture('detail.json',detail(),'details');
    const result=await invoke([source,source,details]);assert.equal(result.status,0,result.stderr);
    const summary=JSON.parse(result.stdout),report=JSON.parse(await readFile(result.output,'utf8'));
    assert.equal(summary.status,'diagnostic_complete');assert.equal(summary.uniqueMaps,1);assert.equal(summary.detailedMaps,1);
    assert.equal(report.observations,3);assert.equal(report.repeatedObservations,2);assert.equal(report.duplicateCaptures,1);
    assert.equal(report.maps[0].matchId,'9007199254740993');assert.deepEqual(report.bySplit,{train:1});
    assert.equal(summary.strictHistoricalEligibility,'not_assessed');assert.equal(summary.trainingReady,false);assert.equal(summary.deployable,false);
    assert.equal(report.remoteCorpusCompleteness,'unknown');assert.equal(report.seriesMembershipCompleteness,'unknown');
    assert.ok(report.blockers.includes('CANONICAL_VERIFIED_DATASET_REQUIRED'));
    assert.equal('teamAWinProbability' in report,false);
  });
});

test('corpus CLI rejects a modified capture when its expected SHA no longer matches',async()=>{
  await workspace(async({capture,invoke,path})=>{
    const source=await capture('discovery.json',discovery([match()]));
    await writeFile(path('discovery.json'),JSON.stringify(discovery([])),'utf8');
    const result=await invoke([source]);assert.equal(result.status,1);assert.equal(result.stdout,'');
    assert.match(result.stderr,/SHA capture/);
    await assert.rejects(readFile(result.output),{code:'ENOENT'});
  });
});

test('corpus CLI rejects report, catalog, cohort and detail timestamps after the snapshot horizon',async()=>{
  await workspace(async({capture,invoke})=>{
    const future='2026-02-01T00:00:00.001Z';
    const cases=[
      ()=>({...discovery([match()]),generated_at:future}),
      ()=>{const r=discovery([match()]);r.selection_catalog.source_evidence.fetched_at=future;return r;},
      ()=>{const r=discovery([match()]);r.cohorts[0].source_evidence.fetched_at=future;return r;},
      ()=>{const r=detail();r.observations[0].source_evidence.fetched_at=future;return r;}
    ];
    for(const [i,make]of cases.entries()){
      const result=await invoke([await capture('capture.json',make(),i===3?'details':'discovery')]);
      assert.equal(result.status,1);assert.equal(result.stdout,'');
      await assert.rejects(readFile(result.output),{code:'ENOENT'});
    }
  });
});

test('corpus CLI refuses explicit synthetic capture mode and does not leave an output artifact',async()=>{
  await workspace(async({capture,invoke})=>{
    for(const [body,kind]of [[discovery([match()]),'discovery'],[detail(),'details']]){
      body.mode='synthetic_fixture';
      const result=await invoke([await capture('capture.json',body,kind)]);
      assert.equal(result.status,1);assert.equal(result.stdout,'');
      await assert.rejects(readFile(result.output),{code:'ENOENT'});
    }
  });
});

test('corpus CLI uses exclusive report creation and preserves existing bytes on repeated execution',async()=>{
  await workspace(async({capture,invoke})=>{
    const source=await capture('discovery.json',discovery([match()]));
    const first=await invoke([source]);assert.equal(first.status,0,first.stderr);
    const bytes=await readFile(first.output);
    const repeat=await invoke([source]);assert.equal(repeat.status,1);assert.equal(repeat.stdout,'');
    assert.match(repeat.stderr,/уже существует/);assert.deepEqual(await readFile(first.output),bytes);
  });
});
