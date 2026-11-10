import { realpath, lstat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { RETEST_REGISTRY_LIMITS } from '../../packages/contracts/dist/v1-retest-registry.js';
import { bounded, sha } from './v1-historical-protocol.mjs';
export async function readRetestRegistryBundle(directory, freezeSha256, capsuleSha256, reportSha256) {
  const root = await realpath(directory), files = { capsule: 'frozen/input.json', freeze: 'frozen/executable.json',
    started: 'evaluation/started.json', report: 'evaluation/report.json', binding: 'evaluation/registry.json' };
  const pins = { capsule: capsuleSha256, freeze: freezeSha256, report: reportSha256 }, values = {};
  for (const [key, relative] of Object.entries(files)) {
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep) || await realpath(path) !== path || !(await lstat(path)).isFile()) throw Error('retest_registry_bundle_path');
    const input = await bounded(path, RETEST_REGISTRY_LIMITS[key], pins[key]);
    values[key] = { text: input.bytes.toString('utf8'), sha256: sha(input.bytes) };
  }
  return { schemaVersion: 1, format: 'v1-retest-registry-evidence-v1', ...values };
}
