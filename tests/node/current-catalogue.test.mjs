import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareCurrentCatalogue} from '../../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const read=f=>readFile(new URL('../../'+f,import.meta.url)),json=async f=>JSON.parse(await read(f));
test('current review/apply/replay keeps the selected numeric accounts and current clocks without duplicating identities',async()=>{
  const manifest=await json('docs/evidence/s1-12-current.manifest.json');
  for(const artifact of manifest.artifacts)assert.equal(sha(await read(artifact.file)),artifact.sha256);
  assert.equal(manifest.requests.opendota.attempts,4);assert.equal(manifest.verification.workingCounts.players,21);
  const review=await json('docs/evidence/s1-12-current-reviewed.json'),p=await json('docs/evidence/s1-12-current-preview.json'),
    a=await json('docs/evidence/s1-12-current-applied.json'),r=await json('docs/evidence/s1-12-current-replay.json');
  assert.equal(p.review.sha256,sha(await read(p.review.file)));assert.equal(a.planInput.sha256,sha(await read(a.planInput.file)));
  assert.equal(review.policyVersion,'reviewed-current-catalogue-v1');assert.equal(review.source.knownAt,review.source.fetchedAt);
  assert.equal(review.accounts.length,11);assert.equal(review.teams.length,2);assert.equal(p.plan.status,'ready');
  assert.equal(p.databaseWrites,0);assert.equal(a.playersCreated,11);assert.equal(a.teamsCreated,1);assert.equal(a.accountProofsAdded,11);
  assert.equal(r.status,'already_applied');assert.equal(r.databaseWrites,0);assert.deepEqual(r.planAfter,a.planAfter);
  assert.equal(a.planAfter.identityRevision,'42');assert.equal(new Set(a.planAfter.rows.map(x=>x.playerId)).size,11);
  for(const report of [p,a,r]){assert.equal(report.networkRequests,0);assert.equal(report.trainingExamples,0);assert.equal(report.deployable,false);}
  assert.equal(a.reportedMemberships.filter(m=>m.reportedTeamId==='9823272').length,6);
});
test('CLI rejects overwritten destinations, source tampering and bad plan hashes before DB access, without leaking secrets',async()=>{
  await mkdir(new URL('../../reports/',import.meta.url),{recursive:true});const prefix='reports/catalogue-guard-'+randomUUID();
  const files=[prefix+'-source.json',prefix+'-review.json',prefix+'-plan.json',prefix+'-out.json',prefix+'-other.json'];
  const observation=(endpoint,data)=>{const rawBody=JSON.stringify(data);return {rawBody,source:{provider:'opendota',endpoint,
    fetchedAt:'2026-01-01T00:00:00.000Z',knownAt:null,payloadSha256:sha(rawBody)}};};
  const capture={schemaVersion:1,mode:'current_catalogue_capture',registry:observation('/proPlayers',[
    {account_id:101,steamid:'76561197960265829',name:'Synthetic player',team_id:9}]),
    teams:[observation('/teams/9',{team_id:9,name:'Synthetic team'})]};
  const source=JSON.stringify(capture),review=prepareCurrentCatalogue(capture,sha(source),'2026-01-02T00:00:00.000Z').review;
  const run=args=>spawnSync(process.execPath,['scripts/current-catalogue.mjs',...args],{cwd:root,encoding:'utf8',timeout:15000,
    env:{...process.env,DATABASE_URL:'synthetic-private-database-secret'}});
  try{
    await writeFile(new URL('../../'+files[0],import.meta.url),source);
    await writeFile(new URL('../../'+files[1],import.meta.url),JSON.stringify(review));
    await writeFile(new URL('../../'+files[2],import.meta.url),'{}');
    const before=await read(files[0]);
    const apply=['apply','--source',files[0],'--review',files[1],'--plan',files[2],'--sha256','0'.repeat(64),'--out',files[3]];
    const badPlan=run(apply);assert.equal(badPlan.status,1);assert.equal(badPlan.stdout,'');
    assert.doesNotMatch(badPlan.stderr,/synthetic-private|postgres:|SELECT|INSERT/);
    const overwrite=run(['preview','--source',files[0],'--review',files[1],'--out',files[0]]);
    assert.equal(overwrite.status,1);assert.deepEqual(await read(files[0]),before);
    capture.registry.rawBody+=' ';await writeFile(new URL('../../'+files[0],import.meta.url),JSON.stringify(capture));
    const tampered=run(['preview','--source',files[0],'--review',files[1],'--out',files[4]]);
    assert.equal(tampered.status,1);assert.equal(tampered.stdout,'');assert.doesNotMatch(tampered.stderr,/synthetic-private|postgres:/);
    assert.equal(run(['capture','--team-ids','9','--out','../outside.json']).status,1);
  }finally{for(const f of files)await unlink(new URL('../../'+f,import.meta.url)).catch(e=>{if(e.code!=='ENOENT')throw e;});}
});
