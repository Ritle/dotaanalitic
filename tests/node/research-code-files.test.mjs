import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { researchCodeReferences } from '../../scripts/lib/research-code-files.mjs';

const files = count => Array.from({ length: count }, (_, index) => ({ path: `synthetic/module-${String(index).padStart(4, '0')}.js`, sha256: 'a'.repeat(64) }));
async function temporary(run) {
 const parent = await realpath(tmpdir()), root = await mkdtemp(path.join(parent, 'dota-code-manifest-'));
 try { await run(root); } finally {
  assert.equal(await realpath(root), root);
  assert.equal(path.dirname(root), parent);
  assert.match(path.basename(root), /^dota-code-manifest-[A-Za-z0-9]+$/);
  await rm(root, { recursive: true });
 }
}
test('legacy code inventories remain direct references without creating an artifact', () => temporary(async root => {
 const inventory = files(256);
 assert.deepEqual(await researchCodeReferences(root, inventory), inventory);
 assert.deepEqual(await readdir(root), []);
}));
test('large code inventory retains every file under a verified immutable SHA and exact retries reuse it', () => temporary(async root => {
 const inventory = files(264), references = await researchCodeReferences(root, inventory);
 assert.equal(references.length, 1);
 const filename = path.join(root, references[0].path), bytes = await readFile(filename), before = await stat(filename);
 assert.equal(createHash('sha256').update(bytes).digest('hex'), references[0].sha256);
 assert.deepEqual(JSON.parse(bytes), { schemaVersion: 1, format: 'research-executable-file-manifest-v1', files: inventory });
 assert.deepEqual(await researchCodeReferences(root, [...inventory].reverse()), references);
 assert.equal((await stat(filename)).mtimeMs, before.mtimeMs);
 inventory[0] = { ...inventory[0], sha256: 'b'.repeat(64) };
 assert.notEqual((await researchCodeReferences(root, inventory))[0].sha256, references[0].sha256);
 assert.deepEqual(await readFile(filename), bytes);
}));
test('concurrent publication cannot expose partial JSON or overwrite a conflicting manifest', () => temporary(async root => {
 const inventory = files(257), attempts = await Promise.allSettled(Array.from({ length: 4 }, () => researchCodeReferences(root, inventory)));
 for (const attempt of attempts) if (attempt.status === 'rejected') throw attempt.reason;
 const results = attempts.map(attempt => attempt.value);
 assert(results.every(result => JSON.stringify(result) === JSON.stringify(results[0])));
 const filename = path.join(root, results[0][0].path);
 assert.equal((await readdir(path.dirname(filename))).length, 1);
 await writeFile(filename, 'corrupt');
 await assert.rejects(researchCodeReferences(root, inventory), /research_code_manifest_conflict/);
 assert.equal(await readFile(filename, 'utf8'), 'corrupt');
 assert.equal((await readdir(path.dirname(filename))).length, 1);
}));
test('invalid, duplicate and unbounded inventories are rejected before creating files', () => temporary(async root => {
 for (const inventory of [[], files(4097), [files(1)[0], files(1)[0]], [{ path: 'synthetic.js', sha256: 'invalid' }]]) {
  await assert.rejects(researchCodeReferences(root, inventory));
 }
 assert.deepEqual(await readdir(root), []);
}));
