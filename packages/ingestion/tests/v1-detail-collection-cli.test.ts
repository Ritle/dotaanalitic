import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { releasePlanFixture } from '../../db/tests/v1-release-plan-fixtures.js';
import { canonicalContextJson } from '../../db/src/temporal.js';
import { releaseEvidenceFixture, releaseSha } from './v1-release-evidence-fixtures.js';

// Synthetic evidence only. Exercise the real union/receipt replay and detail CLI without HTTP or DB.
it('recovers and exports managed details through the unchanged source verifier', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'dota-managed-detail-'));
  const save = async (name: string, value: unknown) => {
    const path = join(dir, name), bytes = JSON.stringify(value);
    await writeFile(path, bytes, { flag: 'wx' });
    return { path, sha256: releaseSha(bytes), bytes: Buffer.byteLength(bytes) };
  };
  const sealed = (body: object) => ({ ...body, fingerprint: releaseSha(canonicalContextJson(body)) });
  try {
    const base = releasePlanFixture();
    const catalogue = await save('catalogue.json', base.catalogue), development = await save('development.json', base.development);
    base.request.catalogueSha256 = catalogue.sha256; base.request.developmentDatasetSha256 = development.sha256;
    const f = releaseEvidenceFixture(base), plan = await save('plan.json', f.plan);
    const config = await save('config.json', { kind: 'v1', planPath: plan.path, planSha256: plan.sha256,
      evidenceAPath: catalogue.path, evidenceBPath: development.path, limits: f.limits });
    await mkdir(join(dir, 'runs/01/capture'), { recursive: true });
    await mkdir(join(dir, 'unions/first'), { recursive: true });
    const request = await save('runs/01/capture/request.json', {}), receipts = [];
    for (const [i, entry] of f.entries.entries()) {
      const name = `receipt-${String(i).padStart(3, '0')}.json`, ref = await save('runs/01/capture/' + name, entry);
      receipts.push({ ...ref, path: name });
    }
    const discovery = await save('runs/01/capture/manifest.json', sealed({ format: 'evaluation-discovery-run-v1',
      configSha256: config.sha256, request, receipts, ledger: f.ledger }));
    const union = await save('unions/first/union.json', sealed({ schemaVersion: 1, format: 'evaluation-discovery-union-v1',
      configSha256: config.sha256, runs: [{ directory: join(dir, 'runs/01/capture'), manifestSha256: discovery.sha256 }],
      ledger: f.ledger, aggregation: 'all_supplied_runs_union_no_removal_or_conflict_overwrite',
      sourceHistoryCompleteness: 'only_explicitly_supplied_runs', metrics: null, deployable: false }));
    await save('unions/first/result.json', { status: 'merged', unionPath: union.path, unionSha256: union.sha256,
      discoveryConfigSha256: config.sha256 });
    const ctx = await save('context.json', { root: dir, configPath: config.path,
      session: { discoveryConfigSha256: config.sha256, planFingerprint: f.plan.fingerprint },
      rows: [{ directory: join(dir, 'runs/01'), receipt: { status: 'captured', manifestSha256: discovery.sha256 } }] });
    const fixture = await save('fixture.json', { entries: f.detailEntries, assessment: f.batches[0]!.report, at: f.at });
    const managerUrl = pathToFileURL(join(root, 'scripts/lib/v1-detail-collection.mjs')).href;
    const filesUrl = pathToFileURL(join(root, 'scripts/lib/evaluation-discovery-files.mjs')).href;
    const driver = `
      import assert from 'node:assert/strict';
      import {readFile,mkdir,writeFile} from 'node:fs/promises';
      import {join} from 'node:path'; import {spawnSync} from 'node:child_process';
      import {detailCollectionManager} from ${JSON.stringify(managerUrl)};
      import {save} from ${JSON.stringify(filesUrl)};
      const ctx=JSON.parse(await readFile(process.argv[2],'utf8'));
      const f=JSON.parse(await readFile(process.argv[3],'utf8'));
      const unionPath=process.argv[4], unionSha=process.argv[5], repo=process.argv[6];
      let replays=0;
      ctx.now=()=>f.at;
      ctx.runChild=async(script,args)=>{
        assert.equal(script,'evaluation-details.mjs'); assert.equal(args[0],'verify'); replays++;
        const r=spawnSync(process.execPath,[join(repo,'scripts',script),...args],
          {encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,DATABASE_URL:'invalid-offline-sentinel'}});
        assert.equal(r.status,0,r.stderr); return {exitCode:r.status,output:JSON.parse(r.stdout)};
      };
      const manager=detailCollectionManager({manager:{withSession:async(_root,_sha,operation)=>operation(ctx)}});
      const args=[ctx.root,'synthetic-collection',unionSha];
      const prepared=await manager.init(ctx.root,args[1],unionPath,unionSha);
      assert.equal(prepared.requiredBatches,1);
      const base=join(ctx.root,'details',unionSha), batch=join(base,'batches/00'), capture=join(batch,'capture');
      await mkdir(capture,{recursive:true});
      const intent={batchIndex:0,createdAt:f.at,planSha256:prepared.planSha256};
      await save(join(base,'attempts/00.json'),intent); await save(join(batch,'intent.json'),intent);
      const request=await save(join(capture,'request.json'),{}), receipts=[];
      for(const [i,entry] of f.entries.entries()){
        const path='receipt-'+String(i).padStart(3,'0')+'.json';receipts.push({path,...await save(join(capture,path),entry)});
      }
      const {canonicalContextJson}=await import(${JSON.stringify(pathToFileURL(join(root, 'packages/db/dist/index.js')).href)});
      const {sha}=await import(${JSON.stringify(filesUrl)});
      const body={format:'evaluation-details-capture-v1',unionSha256:unionSha,discoveryFingerprint:f.assessment.discoveryFingerprint,
        request,receipts,assessment:f.assessment};
      body.discoveryFingerprint=JSON.parse(await readFile(unionPath,'utf8')).ledger.fingerprint;
      await save(join(capture,'manifest.json'),{...body,fingerprint:sha(canonicalContextJson(body))});
      assert.equal((await manager.recover(...args)).batches,1);
      assert.equal((await manager.status(...args)).inventoryComplete,true);
      const exported=await manager.export(...args); assert.equal(exported.requiredBatches,1); assert.equal(exported.sourceIneligible,0);
      assert.equal(exported.readyForEvaluation,false);
      await writeFile(join(capture,'receipt-002.json'),'{}');
      await assert.rejects(manager.export(...args));
      console.log(JSON.stringify({replays,exported:true,tamperRejected:true}));
    `;
    await writeFile(join(dir, 'driver.mjs'), driver);
    const result = spawnSync(process.execPath, [join(dir, 'driver.mjs'), ctx.path, fixture.path, union.path, union.sha256, root],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 90000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ replays: 4, exported: true, tamperRejected: true });
    expect(JSON.parse(await readFile(join(dir, 'details', union.sha256, 'batches/00/result.json'), 'utf8')).recovered).toBe(true);
  } finally {
    expect(dir.startsWith(resolve(tmpdir()) + sep + 'dota-managed-detail-')).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
