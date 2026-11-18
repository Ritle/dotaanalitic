import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {buildPostDraftPlan} from '../../tools/research/post-draft-plan.mjs';
const policy=JSON.parse(readFileSync(new URL('../../tools/research/post-draft-policy.json',import.meta.url),'utf8'));
const row=(matchId,startedAt='2026-04-01T00:00:00.000Z',series='1')=>({matchId,startedAt,completedAt:new Date(Date.parse(startedAt)+3600000).toISOString(),dataRevision:'1',seriesId:'uuid-'+series,seriesProvider:'opendota',sourceSeriesId:series,gameMode:'2',lobbyType:'1'});
const inv=(rows,bad=[])=>{const body={policyVersion:'post-draft-readiness-inventory-v1',maps:rows.map(r=>({matchId:r.matchId,startedAt:r.startedAt,dataRevision:'1',lineupSha256:'a'.repeat(64),sourceSha256:'b'.repeat(64),researchInventoryCandidate:!bad.includes(r.matchId)})),trainingReady:false,deployable:false};return {computedAt:'2026-11-13T00:00:00.000Z',...body,fingerprint:createHash('sha256').update(JSON.stringify(body)).digest('hex')};};
test('series crossing time boundaries and late completion never enter either fold',()=>{
 for(const rows of [[row('1','2026-04-30T20:00:00.000Z'),row('2','2026-05-01T01:00:00.000Z')],[row('1','2026-04-30T23:30:00.000Z')]]){
  const plan=buildPostDraftPlan(inv(rows),rows,policy);assert.equal(plan.excludedMaps,rows.length);assert(plan.dispositions.every(r=>r.reasons.includes('SERIES_CROSSES_BOUNDARY')));}
});
test('an ineligible or non-CM sibling excludes the whole known series and stays in denominator',()=>{
 const rows=[row('1'),row('2')];for(const bad of [true,false]){if(!bad)rows[1].gameMode='1';const plan=buildPostDraftPlan(inv(rows,bad?['2']:[]),rows,policy);assert.equal(plan.partitions.train.maps,0);assert.equal(plan.partitions.train.plannedDenominator,2);assert.equal(plan.excludedMaps,2);}
});
test('provider-series aliases merge across local IDs; conflicting aliases and unknown series fail safely',()=>{
 const rows=[row('1','2026-04-30T20:00:00.000Z'),row('2','2026-05-01T01:00:00.000Z')];rows[1].seriesId='another-local';assert.equal(buildPostDraftPlan(inv(rows),rows,policy).excludedMaps,2);
 rows[1].seriesId=rows[0].seriesId;rows[1].sourceSeriesId='2';assert.throws(()=>buildPostDraftPlan(inv(rows),rows,policy),/alias_conflict/);
 const unknown=row('1');unknown.sourceSeriesId=null;assert.equal(buildPostDraftPlan(inv([unknown]),[unknown],policy).excludedMaps,1);
});
test('map IDs are unique bigint strings, revisions and complete metadata match inventory',()=>{
 const rows=[row('9007199254740993')],inventory=inv(rows);assert.equal(buildPostDraftPlan(inventory,rows,policy).partitions.train.mapIds[0],rows[0].matchId);
 assert.throws(()=>buildPostDraftPlan(inv([rows[0],rows[0]]),[rows[0],rows[0]],policy),/duplicate/);
 assert.throws(()=>buildPostDraftPlan(inventory,[],policy),/metadata_size/);rows[0].dataRevision='2';assert.throws(()=>buildPostDraftPlan(inventory,rows,policy),/stale/);
});
test('labels and input ordering cannot select partitions; deployed model remains unavailable by this protocol',()=>{
 const rows=[row('1'),row('2','2026-09-15T00:00:00.000Z','2')],inventory=inv(rows),a=buildPostDraftPlan(inventory,rows,policy);
 const b=buildPostDraftPlan(inventory,rows.map(r=>({...r,radiant_win:true,probability:0.99})).reverse(),policy);assert.deepEqual(a,b);assert.equal(a.deployable,false);assert.equal(a.trainingReady,false);assert.equal(a.labelsRead,false);
 inventory.maps[0].researchInventoryCandidate=false;assert.throws(()=>buildPostDraftPlan(inventory,rows,policy),/fingerprint/);
});
test('invalid calendar windows and completion timestamps are rejected',()=>{
 const rows=[row('1')],p=structuredClone(policy);p.windows[2].from=p.windows[0].from;assert.throws(()=>buildPostDraftPlan(inv(rows),rows,p),/windows/);
 rows[0].completedAt=rows[0].startedAt;assert.throws(()=>buildPostDraftPlan(inv(rows),rows,policy),/metadata/);
});
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve as resolvePath,join,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
test('offline CLI verifies exact inputs, refuses overwrite and detects modified protocol bytes',async t=>{
 const parent=resolvePath(tmpdir()),dir=await mkdtemp(join(parent,'dota-post-draft-plan-'));
 t.after(async()=>{assert(dir.startsWith(parent+sep)&&dir.includes('dota-post-draft-plan-'));await rm(dir,{recursive:true});});
 const rows=[row('1')],inventory=join(dir,'inventory.json'),metadata=join(dir,'metadata.json'),protocol=join(dir,'protocol.json');
 await writeFile(inventory,JSON.stringify(inv(rows)));await writeFile(metadata,JSON.stringify(rows));
 const cli=fileURLToPath(new URL('../../tools/research/post-draft-plan.mjs',import.meta.url));
 const run=(mode,file=protocol)=>execFileSync(process.execPath,[cli,mode,inventory,metadata,file],{encoding:'utf8',env:{...process.env,DATABASE_URL:'not-used-by-offline-plan'},stdio:['ignore','pipe','pipe']});
 assert.equal(JSON.parse(run('create')).status,'registered_research_only');assert.equal(JSON.parse(run('verify')).status,'verified_research_only');
 const before=await readFile(protocol);assert.throws(()=>run('create'));assert.deepEqual(await readFile(protocol),before);
 const copy=join(dir,'tampered.json'),bad=JSON.parse(before);bad.partitions.train.mapIds=[];await writeFile(copy,JSON.stringify(bad));assert.throws(()=>run('verify',copy));
 rows[0].radiant_win=true;await writeFile(metadata,JSON.stringify(rows));assert.throws(()=>run('verify'));
});
