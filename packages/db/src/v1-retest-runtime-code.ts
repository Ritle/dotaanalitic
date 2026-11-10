import { readFile, readdir } from 'node:fs/promises';
import { readV1RuntimeCode } from './v1-runtime-code.js';
import { registrySha } from './v1-registry.js';
/** Pin the new orchestration separately from the unchanged scored kernel. */
export async function readRetestRuntimeCode() {
  const root = new URL('../../../', import.meta.url), runtime = await readV1RuntimeCode();
  const paths = (await Promise.all(['scripts/', 'scripts/lib/', 'packages/ingestion/dist/'].map(async dir =>
    (await readdir(new URL(dir, root))).filter(n => n.endsWith('.mjs') || n.endsWith('.js') || n === 'v1-retest-runtime-compatibility.json')
      .map(n => dir + n)))).flat().concat('packages/ingestion/package.json').sort();
  const admission = await Promise.all(paths.map(async path => {
    return { path, sha256: registrySha(await readFile(new URL(path, root), 'utf8')) };
  }));
  return { policy: 'v1-retest-runtime-admission-v1', runtime, admission };
}
