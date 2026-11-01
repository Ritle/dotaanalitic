import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,mkdir,unlink} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const read=file=>readFile(new URL('../../'+file,import.meta.url));
const run=args=>spawnSync(process.execPath,['scripts/audit-upcoming-matches.mjs',...args],{cwd:root,encoding:'utf8',timeout:15000,
  env:{...process.env,PANDASCORE_API_TOKEN:'',DATABASE_URL:'synthetic-unused-secret'}});
test('schedule CLI reports missing credentials without HTTP, fake fixtures or private environment',async()=>{
  const out='reports/test-upcoming-'+randomUUID()+'.json';await mkdir(new URL('../../reports/',import.meta.url),{recursive:true});
  try{const r=run(['--out',out]);assert.equal(r.status,3);assert.doesNotMatch(r.stdout+r.stderr,/synthetic-unused-secret/);
    const report=JSON.parse(await read(out));assert.equal(report.captureStatus,'blocked');assert.equal(report.schedule,null);
    assert.equal(report.coverage,null);assert.equal(report.requests.attempts,0);assert.equal(report.errors[0].code,'missing_api_token');
    assert.equal(report.databaseWrites,0);assert.equal(report.trainingExamples,0);
  }finally{await unlink(new URL('../../'+out,import.meta.url)).catch(()=>{});}
});
test('schedule CLI rejects path escape, invalid IDs and token arguments before network',()=>{
  for(const args of [['--out','../outside.json'],['--out','reports/new.json','--tournament','x/secret'],['--token','secret']]){
    const r=run(args);assert.equal(r.status,2);assert.equal(r.stdout,'');assert.doesNotMatch(r.stderr,/synthetic-unused-secret|x\/secret/);
  }
});
test('schedule CLI preserves an existing capture before credential access',async()=>{
  const file='docs/evidence/s1-09-upcoming-source.json',before=await read(file),r=run(['--out',file]);
  assert.equal(r.status,2);assert.equal(r.stdout,'');assert.equal(sha(await read(file)),sha(before));
});
test('captured future series, tournament roster and provider IDs remain source evidence',async()=>{
  const m=JSON.parse(await read('docs/evidence/s1-09-upcoming-source.manifest.json'));
  for(const b of [m.report,m.preliminary,m.failedAttempt,m.schemaDiagnostic])assert.equal(sha(await read(b.file)),b.sha256);
  assert.equal(m.directProviderRequests,7);assert.deepEqual(m.httpStatuses,{'200':7});assert.equal(m.workingState.datasets,0);
  const r=JSON.parse(await read(m.report.file));assert.equal(r.captureStatus,'complete');assert.deepEqual(r.errors,[]);
  assert.equal(r.requests.attempts,3);assert.deepEqual(r.requests.httpStatuses,{'200':3});
  assert.equal(r.selectedMatch.providerMatchId,'1753769');assert.equal(r.selectedMatch.tournament.providerTournamentId,'22231');
  assert.equal(r.selectedMatch.seriesBestOf,5);assert.ok(r.selectedMatch.scheduledAt>r.generatedAt);
  assert.equal(r.schedule.data.length,20);assert.equal(r.teams.length,2);assert.ok(r.rosters.data.length>=2);
  assert.equal(r.identityProbe.data.scope,'field_inventory_only');assert.equal(r.identityProbe.data.steamAccountId,null);
  assert.equal(r.coverage.canonicalPlayersLinked,0);assert.equal(r.coverage.playerHistoryLinks,'requires_verified_provider_mapping');
  assert.ok(r.teams.every(t=>t.matchAttendanceConfirmed===false));assert.equal(r.trainingExamples,0);assert.equal(r.deployable,false);
  assert.doesNotMatch(JSON.stringify(r),/"(?:birthday|first_name|last_name|nationality|image_url|email|Authorization|token|apiToken)"|synthetic-unused-secret/);
  const p=JSON.parse(await read(m.preliminary.file));assert.equal(p.coverage.expectedLineupReady,false);
  assert.deepEqual(p.teams.map(t=>t.expectedPlayerCount),[6,6]);assert.ok(p.teams.every(t=>t.rosterStatus==='requires_manual_selection'));
});
