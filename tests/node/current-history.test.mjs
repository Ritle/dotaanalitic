import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const read=f=>readFile(new URL('../../'+f,import.meta.url)),json=async f=>JSON.parse(await read(f));
test('live audit binds ten pro maps to a reviewed import and exact replay; real reports retain small/zero sample semantics',async()=>{
  const manifest=await json('docs/evidence/s1-13-current-history.manifest.json');
  for(const artifact of manifest.artifacts)assert.equal(sha(await read(artifact.file)),artifact.sha256);
  assert.equal(manifest.finalCounts.temporary_databases,0);
  const audit=await json('docs/evidence/s1-13-current-history-audit.json'),plan=await json('docs/evidence/s1-13-current-history-preview.json'),
    applied=await json('docs/evidence/s1-13-current-history-applied.json'),replay=await json('docs/evidence/s1-13-current-history-replay.json'),
    reports=await json('docs/evidence/s1-13-current-history-reports.json');
  assert.equal(audit.mode,'live_opendota');assert.equal(audit.requests.attempts,14);assert.equal(audit.coverage.confirmed_pro.count,10);
  assert.equal(audit.coverage.identity_10.count,10);assert.equal(audit.coverage.canonical_identity_10.ratio,null);
  assert.equal(sha(await read(plan.audit.file)),plan.audit.sha256);assert.equal(plan.capture.sha256,audit.current_history_capture.sha256);
  assert.equal(applied.planInput.sha256,sha(await read(applied.planInput.file)));assert.equal(plan.existingMaps.length,1);
  assert.equal(applied.results.length,10);assert.ok(applied.results.every(r=>r.status==='accepted'));
  assert.ok(replay.results.every(r=>r.duplicate));assert.deepEqual(replay.mapsAfter,applied.mapsAfter);
  assert.equal(reports.counts.maps,10);assert.equal(reports.counts.map_players,100);assert.equal(reports.counts.resolved_map_players,53);
  assert.equal(reports.counts.datasets+reports.counts.active_models,0);
  assert.equal(reports.teams.length,2);for(const t of reports.teams){assert.equal(t.report.summary.nRaw,5);assert.equal(t.report.summary.wins,4);
    assert.equal(t.report.summary.sampleEvidence.smallSample,true);assert.equal(t.report.coverage.knownPatch,0);assert.equal(t.report.coverage.knownSeries,0);
    assert.equal(t.report.scope,'retrospective_descriptive');assert.equal(t.report.predictionEligibility,'not_assessed');}
  assert.equal(reports.players.filter(p=>p.summary.nRaw===5).length,10);
  assert.equal(reports.players.find(p=>p.accountId==='56351509').summary.winRate,null);
});
test('current-history CLIs reject overwrite, source/audit/plan tampering and path escape before network or DB use',async()=>{
  await mkdir(new URL('../../reports/',import.meta.url),{recursive:true});const prefix='reports/history-guard-'+randomUUID();
  const files=['capture','audit','plan','out','out2','out3'].map(n=>`${prefix}-${n}.json`);
  const observation=(endpoint,data)=>{const rawBody=JSON.stringify(data);return {rawBody,source:{provider:'opendota',adapterVersion:'synthetic-history-cli-test',endpoint,
    fetchedAt:'2026-01-01T00:00:01.000Z',knownAt:null,payloadSha256:sha(rawBody),attempts:1,rateLimitRemaining:{minute:null,day:null,month:null}}};};
  const map={match_id:101,start_time:1767139200,duration:1000,radiant_win:true,leagueid:9,radiant_team_id:1,dire_team_id:2};
  const capture={schemaVersion:1,mode:'live_current_history_capture',cutoffAt:'2026-01-01T00:00:00.000Z',capturedAt:'2026-01-01T00:00:02.000Z',
    teamIds:['1'],sample:1,discoveries:[observation('/teams/1/matches',[{...map,radiant:true}])],heroes:observation('/heroes',[]),
    leagues:observation('/leagues',[{leagueid:9,tier:'professional'}]),matches:[observation('/matches/101',map)],errors:[]};
  const captureBytes=JSON.stringify(capture),auditBytes=JSON.stringify({mode:'live_opendota',current_history_capture:{sha256:sha(captureBytes),eligibleMatchIds:['101']},
    selection:{team_ids:['1'],selected_match_ids:['101']}});
  const run=(script,args)=>spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8',timeout:15000,
    env:{...process.env,DATABASE_URL:'synthetic-private-history-secret',OPENDOTA_API_KEY:'synthetic-private-source-secret'}});
  const common=['--capture',files[0],'--audit',files[1],'--audit-sha256',sha(auditBytes)];
  try{
    for(const [i,bytes] of [captureBytes,auditBytes,'{}'].entries())await writeFile(new URL('../../'+files[i],import.meta.url),bytes);
    const calls=[['scripts/import-current-history.mjs',['apply',...common,'--plan',files[2],'--plan-sha256','0'.repeat(64),'--out',files[3]]],
      ['scripts/import-current-history.mjs',['preview',...common,'--out',files[0]]],
      ['scripts/audit-prediction-sources.mjs',['--teams','1','--sample','1','--capture',files[0],'--out',files[4]]],
      ['scripts/audit-prediction-sources.mjs',['--teams','1','--capture','../escape.json','--out',files[4]]]];
    for(const [script,args] of calls){const c=run(script,args);assert.notEqual(c.status,0);assert.equal(c.stdout,'');assert.doesNotMatch(c.stderr,/synthetic-private|postgres:|SELECT|INSERT/);}
    assert.equal(sha(await read(files[0])),sha(captureBytes));
    capture.matches[0].rawBody+=' ';await writeFile(new URL('../../'+files[0],import.meta.url),JSON.stringify(capture));
    assert.equal(run('scripts/import-current-history.mjs',['preview',...common,'--out',files[5]]).status,1);
  }finally{for(const file of files)await unlink(new URL('../../'+file,import.meta.url)).catch(e=>{if(e.code!=='ENOENT')throw e;});}
});
