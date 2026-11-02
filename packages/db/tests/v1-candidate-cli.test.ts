import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { planV1Release } from '../src/v1-release-plan.js';
import { releasePlanFixture } from './v1-release-plan-fixtures.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
it('registers/verifies a synthetic inactive kernel offline, rejects byte/code tampering, overwrites and late creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dota-v1-candidate-'));
  const path = (name: string) => join(directory, name);
  const invoke = (args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/v1-candidate.mjs'), ...args],
    { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, DATABASE_URL: 'invalid-offline-sentinel' } });
  try {
    const f = releasePlanFixture(), now = Date.now(), day = 86400000;
    f.request.events[0]!.fromAt = new Date(now + 30 * day).toISOString();
    f.request.events[0]!.until = new Date(now + 40 * day).toISOString();
    f.request.snapshotAt = new Date(now + 42 * day).toISOString();
    const plan = planV1Release(f.request, f.catalogue, f.development, f.registeredAt), planText = JSON.stringify(plan);
    await writeFile(path('plan.json'), planText); await writeFile(path('catalogue.json'), JSON.stringify(f.catalogue));
    await writeFile(path('development.json'), JSON.stringify(f.development));
    const planArgs = [path('plan.json'), sha(planText), path('catalogue.json'), path('development.json')];
    const created = invoke(['create', ...planArgs, path('candidate.json')]);
    expect(created.error).toBeUndefined(); expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ status: 'inactive_kernel_registered', syntheticOnly: true,
      isActive: false, deployable: false, executableFreezeComplete: false, teamAWinProbability: null });
    const original = await readFile(path('candidate.json'), 'utf8');
    expect(invoke(['verify', path('candidate.json'), sha(original), ...planArgs]).status).toBe(0);
    const duplicate = invoke(['create', ...planArgs, path('candidate.json')]);
    expect(duplicate.status).toBe(1); expect(duplicate.stderr).toContain('OUTPUT_EXISTS');
    expect(await readFile(path('candidate.json'), 'utf8')).toBe(original);
    const altered = JSON.parse(original); altered.registration.code[0].sha256 = '0'.repeat(64);
    const tampered = JSON.stringify(altered); await writeFile(path('tampered.json'), tampered);
    const rejected = invoke(['verify', path('tampered.json'), sha(tampered), ...planArgs]);
    expect(rejected.status).toBe(1); expect(rejected.stderr).toContain('V1_CANDIDATE_REPLAY_MISMATCH');
    await writeFile(path('tampered.json'), 'secret-invalid-candidate');
    const wrongSha = invoke(['verify', path('tampered.json'), sha(tampered), ...planArgs]);
    expect(wrongSha.stderr).toContain('CANDIDATE_SOURCE_SHA_MISMATCH'); expect(wrongSha.stderr).not.toContain('secret-invalid-candidate');
    const past = structuredClone(plan); past.request.events[0]!.fromAt = new Date(now - day).toISOString();
    const pastText = JSON.stringify(past); await writeFile(path('past.json'), pastText);
    const early = invoke(['create', path('past.json'), sha(pastText), path('missing-catalogue.json'),
      path('missing-development.json'), path('late.json')]);
    expect(early.status).toBe(1); expect(early.stderr).toContain('CANDIDATE_REGISTRATION_TOO_LATE');
    expect(await readdir(directory)).not.toContain('late.json');
    const before = await readdir(directory);
    expect(invoke(['evaluate', ...planArgs, path('early-score.json')]).status).toBe(2);
    expect(await readdir(directory)).toEqual(before);
  } finally {
    for (const file of await readdir(directory)) await unlink(path(file));
    await rmdir(directory);
  }
}, 60000);
