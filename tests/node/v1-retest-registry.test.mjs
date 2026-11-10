import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture, evidence } from '../helpers/retest-execution.mjs';
import { verifyRetestRegistryEvidence, verifyRetestRegistryCode } from '../../scripts/lib/v1-retest-registry-verifier.mjs';
import { readRetestRegistryBundle } from '../../scripts/lib/v1-retest-registry-bundle.mjs';
import { sha } from '../../scripts/lib/v1-historical-protocol.mjs';
const input = () => { const f = fixture(); return { schemaVersion: 1, format: 'v1-retest-registry-evidence-v1',
  capsule: evidence(f.capsule), freeze: evidence(f.freeze), started: evidence(f.start),
  report: evidence({ syntheticOnly: false, qualityDecision: 'passed', releaseGatePassed: true }), binding: evidence({}) }; };
test('synthetic capsules cannot be admitted by forging a passed report', async () => {
  await assert.rejects(verifyRetestRegistryEvidence(input()), /synthetic_forbidden/);
});
test('failed and synthetic scores fail admission before any code, database or model activation', async () => {
  for (const report of [{ qualityDecision: 'failed', releaseGatePassed: false }, { syntheticOnly: true, qualityDecision: 'passed', releaseGatePassed: true }]) {
    await assert.rejects(verifyRetestRegistryEvidence({ ...input(), report: evidence(report) }), /quality_not_passed|synthetic_forbidden/);
  }
});
test('each exact evidence byte hash is required, even when supplied statuses claim passed', async () => {
  for (const key of ['capsule','freeze','started','report','binding']) {
    const value = input(); value[key].text += ' ';
    await assert.rejects(verifyRetestRegistryEvidence(value), /retest_registry_bytes/);
  }
});
test('code compatibility permits only the named additive barrel exports and refuses changes to inference code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retest-registry-code-'));
  try {
    const old = 'export const original = true;\n', file = 'packages/contracts/dist/index.js';
    await mkdir(join(root, 'packages/contracts/dist'), { recursive: true });
    await writeFile(join(root, file), old + "export * from './v1-retest-registry.js';\n");
    await verifyRetestRegistryCode([{ path: file, sha256: sha(old) }], pathToFileURL(root + sep));
    await writeFile(join(root, file), old + "export * from './unreviewed.js';\n");
    await assert.rejects(verifyRetestRegistryCode([{ path: file, sha256: sha(old) }], pathToFileURL(root + sep)), /code_changed/);
    await writeFile(join(root, 'inference.js'), 'changed');
    await assert.rejects(verifyRetestRegistryCode([{ path: 'inference.js', sha256: sha('original') }], pathToFileURL(root + sep)), /code_changed/);
    await assert.rejects(verifyRetestRegistryCode([{ path: '../escape.js', sha256: sha('x') }], pathToFileURL(root + sep)), /code_path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('bundle input SHA is checked before parsing; CLI errors reveal no source bytes or DB URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retest-registry-cli-'));
  try {
    await mkdir(join(root, 'frozen')); await writeFile(join(root, 'frozen/input.json'), '{"private":"synthetic-private-marker"}');
    await assert.rejects(readRetestRegistryBundle(root, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)));
    const result = spawnSync(process.execPath, ['scripts/register-v1-retest.mjs', 'check', root, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
      { encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgres://synthetic-private-db.invalid/never-connect' }, windowsHide: true });
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).status, 'unavailable');
    assert(!result.stderr.includes('synthetic-private')); assert.equal(result.stdout, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});
