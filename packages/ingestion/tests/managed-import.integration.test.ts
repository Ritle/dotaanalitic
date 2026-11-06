import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { sql, IdentityRepository } from '../../db/src/index.js';
import { managedImportFixture } from './managed-import-fixtures.js';
import { registerV1Candidate } from '../../db/src/v1-candidate.js';
import { registerV1ExecutableFreeze } from '../../db/src/v1-executable-freeze.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));

it('recovers real captured-byte DB writes, reimports after numeric review, and preserves source clocks with no models', async () => {
  const database = await testDatabase(), f = await managedImportFixture();
  try {
    await sql`INSERT INTO teams(id,name,opendota_team_id) VALUES(11,'Synthetic A',111),(22,'Synthetic B',222)`.execute(database.db);
    await mkdir(join(f.dir, 'managed'));
    const codeResult = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import {candidateCodeManifest} from './scripts/lib/v1-candidate-files.mjs';import {releaseExecutionCode,releaseRuntime} from './scripts/lib/v1-release-files.mjs';console.log(JSON.stringify({candidate:await candidateCodeManifest(),execution:await releaseExecutionCode(),runtime:await releaseRuntime()}));"],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    expect(codeResult.status, codeResult.stderr).toBe(0);
    const code = JSON.parse(codeResult.stdout);
    const candidate = registerV1Candidate(f.f.plan, f.f.base.catalogue, f.f.base.development, f.ledger.scope.planSha256, code.candidate,
      f.f.candidate.registration.kernelRegisteredAt);
    const candidateFile = await f.save('candidate.json', candidate);
    const freeze = registerV1ExecutableFreeze(f.f.plan, candidate, f.ledger.scope.planSha256, candidateFile.sha256, code.execution, code.runtime,
      new Date(Date.parse(candidate.registration.kernelRegisteredAt) + 1000).toISOString());
    const freezeFile = await f.save('freeze.json', freeze); await mkdir(join(f.dir, 'frozen'));
    const config = await f.save('frozen/config.json', { planPath: 'plan.json', planSha256: f.ledger.scope.planSha256,
      cataloguePath: 'catalogue.json', developmentPath: 'development.json', candidatePath: 'candidate.json', candidateSha256: candidateFile.sha256,
      freeze: { path: 'freeze.json', sha256: freezeFile.sha256 }, evidence: f.evidence });
    const configBytes = await readFile(config.path);
    const context = await f.save('context.json', { root: f.dir, detailRoot: join(f.dir, 'managed'), configPath: f.evidence.configPath,
      evidence: f.evidence, selections: f.batches.map(b => b.report.selection), session: { bundle: f.dir, configSha256: config.sha256 } });
    const driver = `
      import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises';
      import {spawnSync} from 'node:child_process'; import {join} from 'node:path';
      import {importCollectionManager} from ${JSON.stringify(pathToFileURL(join(root, 'scripts/lib/v1-import-collection.mjs')).href)};
      const ctx=JSON.parse(await readFile(process.argv[2],'utf8')),mode=process.argv[3],repo=process.argv[4];
      ctx.now=()=>new Date().toISOString();let writes=0;
      ctx.runChild=async(script,args)=>{
        assert(['evaluation-details.mjs','release-execute.mjs'].includes(script));
        if(script==='evaluation-details.mjs'){assert.equal(args[0],'import');writes++;}else assert.equal(args[0],'check');
        const r=spawnSync(process.execPath,[join(repo,'scripts',script),...args],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:60000});
        assert.equal(r.status,0,r.stderr);if(mode==='interrupt')throw Error('synthetic_after_commit');
        return {exitCode:0,output:JSON.parse(r.stdout)};
      };
      const manager=importCollectionManager({details:{withDetails:async(_r,_s,_u,operation)=>operation(ctx)}});
      const args=[ctx.root,'synthetic',ctx.evidence.unionSha256];
      let result;
      if(mode==='interrupt'){await assert.rejects(manager.batch(...args,0,1),/recovery_required/);result={status:'interrupted'};}
      else if(mode==='recover')result=await manager.recover(...args,0,1);
      else if(mode==='review')result=await manager.reconcile(...args);
      else if(mode==='export')result=await manager.export(...args,process.argv[5]);
      else result=await manager.batch(...args,0,Number(mode));
      console.log(JSON.stringify({result,writes}));
    `;
    const script = join(f.dir, 'driver.mjs'); await writeFile(script, driver);
    const run = (mode: string, extra?: string) => {
      const r = spawnSync(process.execPath, [script, context.path, mode, root, ...(extra ? [extra] : [])], { cwd: root, encoding: 'utf8', windowsHide: true,
        timeout: 90000, env: { ...process.env, DATABASE_URL: database.url } });
      expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout);
    };
    expect(run('interrupt')).toMatchObject({ result: { status: 'interrupted' }, writes: 1 });
    const failurePath = join(f.dir, 'managed/imports/runs/00-01/result.json'), failure = await readFile(failurePath);
    expect(run('recover')).toMatchObject({ result: { status: 'import_recorded' }, writes: 0 });
    expect(await readFile(failurePath)).toEqual(failure);
    expect(run('1')).toMatchObject({ result: { status: 'import_already_recorded' }, writes: 0 });
    const before = run('review'); expect(before.result.coverage).toMatchObject({ observedTargetMaps: 2, dataReadyMaps: 0 });
    const clock = (await sql`SELECT min(fetched_at)::text first,max(fetched_at)::text last,count(*)::int n FROM provider_ingest_receipts`.execute(database.db)).rows[0];
    expect((await sql`SELECT count(*)::int n FROM match_players WHERE player_id IS NOT NULL`.execute(database.db)).rows[0]).toEqual({ n: 0 });
    const reviewedAt = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      await sql`INSERT INTO players(id,nickname) VALUES(${String(101 + i)},'Synthetic reviewed player')`.execute(database.db);
      await new IdentityRepository(database.db).appendAccountEvidence({ playerId: String(101 + i), provider: 'opendota', externalAccountId: String(10001 + i),
        status: 'verified', eventAt: null, knownAt: reviewedAt, fetchedAt: reviewedAt, source: 'synthetic-numeric-review', evidenceRef: 'synthetic:account' });
    }
    for (const id of ['201', '202']) await sql`INSERT INTO series(team_a_id,team_b_id,provider,provider_series_id)
      VALUES(11,22,'opendota',${id})`.execute(database.db);
    expect(run('2')).toMatchObject({ result: { status: 'import_recorded' }, writes: 1 });
    const after = run('review'); expect(after.result.coverage).toMatchObject({ observedTargetMaps: 2, dataReadyMaps: 2, readyKnownSeries: 2 });
    expect(after.result.readyForEvaluation).toBe(false);
    const exported = run('export', after.result.reviewId);
    expect(exported).toMatchObject({ writes: 0, result: { status: 'import_execution_exported', requiredBatches: 1, readyForEvaluation: false } });
    const execution = JSON.parse(await readFile(exported.result.configPath, 'utf8'));
    expect(execution.freeze.sha256).toBe(freezeFile.sha256); expect(execution.planSha256).toBe(f.ledger.scope.planSha256);
    expect(await readFile(config.path)).toEqual(configBytes);
    const afterClock = (await sql`SELECT min(fetched_at)::text first,max(fetched_at)::text last FROM provider_ingest_receipts`.execute(database.db)).rows[0];
    expect(afterClock).toEqual({ first: clock!.first, last: clock!.last });
    expect((await sql`SELECT count(*)::int n FROM match_players WHERE player_id IS NOT NULL`.execute(database.db)).rows[0]).toEqual({ n: 20 });
    expect((await sql`SELECT (SELECT count(*)::int FROM matches) maps,(SELECT count(*)::int FROM prediction_model_versions) models,
      (SELECT count(*)::int FROM training_dataset_versions) datasets,(SELECT count(*)::int FROM prediction_runs) forecasts`.execute(database.db)).rows[0])
      .toEqual({ maps: 2, models: 0, datasets: 0, forecasts: 0 });
  } finally { await f.cleanup(); await database.close(); }
}, 240000);
