import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {rehearsalInput as input} from '../fixtures/series-forecast-rehearsal.mjs';
import {captureRehearsal} from '../../tools/research/series-forecast-rehearsal.mjs';

async function directory(t) {
  const p = await mkdtemp(join(tmpdir(),'bo3-rehearsal-'));
  t.after(()=>rm(p,{recursive:true,force:true}));
  return p;
}
test('command freezes inputs and both predictions, concurrent retries replay the same receipt',async t=>{
  const dir = await directory(t), bundle = input(), path = join(dir,'input.json');
  await writeFile(path,JSON.stringify(bundle));
  const cli = fileURLToPath(new URL('../../tools/research/series-forecast-rehearsal.mjs',import.meta.url));
  const run = spawnSync(process.execPath,[cli,path],{cwd:dir,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const result = JSON.parse(run.stdout), bytes = await readFile(join(dir,result.path));
  assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));
  const receipt = JSON.parse(bytes);
  assert.deepEqual(receipt.input,bundle);
  assert.equal(receipt.status,'ready');
  const p = receipt.baseMapProbability;
  assert(p>0.5 && p<1);
  assert.equal(receipt.seriesProbability,p*p*(3-2*p));
  assert(Date.parse(receipt.issuedAt)<Date.parse(bundle.target.scheduledAt));
  const [a,b] = await Promise.all([captureRehearsal(dir,bundle),captureRehearsal(dir,bundle)]);
  assert.deepEqual(a,b);
  const changed=structuredClone(bundle); changed.target.editionId='18';
  await assert.rejects(captureRehearsal(dir,changed),/different input/);
  const original = JSON.parse(await readFile(a.path)); original.seriesProbability=0;
  await writeFile(a.path,JSON.stringify(original));
  await assert.rejects(captureRehearsal(dir,bundle),/receipt replay/);
});
test('unavailable series remains in the rehearsal with null probability and no issuance',async t=>{
  const dir = await directory(t), bundle = input();
  bundle.history.maps=[];
  const result = await captureRehearsal(dir,bundle), receipt=JSON.parse(await readFile(result.path));
  assert.equal(receipt.status,'unavailable');
  assert(receipt.reasons.includes('INSUFFICIENT_PLAYER_HISTORY'));
  assert.equal(receipt.issuedAt,null); assert.equal(receipt.seriesProbability,null);
});
test('refuses late inputs, real data, target siblings, hindsight lineups, swapped orientation and target outcomes',async t=>{
  const dir = await directory(t);
  for (const change of [
    b=>{b.target.scheduledAt='2020-01-01T00:00:00.000Z';},
    b=>{b.scenario.cutoffAtUs='1';},
    b=>{b.scenario.lineup.selectedAtUs=b.scenario.cutoffAtUs;},
    b=>{b.history.identities[0].fetchedAt=b.target.scheduledAt;},
    b=>{b.history.syntheticOnly=false;},
    b=>{b.history.maps[0].seriesKey='["synthetic","12"]';},
    b=>{b.scenario.lineup.basis='actual_lineup_reconstructed';},
    b=>{b.target.teamAId='9';},
    b=>{b.target.winner='8';}
  ]) {
    const bundle=input(); change(bundle); await assert.rejects(captureRehearsal(dir,bundle));
  }
});
