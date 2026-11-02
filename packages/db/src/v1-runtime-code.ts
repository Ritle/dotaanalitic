import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { V1ExecutableFreezeSchema } from '@dota/contracts';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
// The old complete executor remains archived. Only the unchanged inference/history closure is
// reused here; new orchestration has its own recorded hashes, not an invented old freeze hash.
export const V1_RUNTIME_KERNEL_PATHS = [
  'pnpm-lock.yaml', 'packages/contracts/package.json', 'packages/prediction/package.json',
  ...['v1-candidate', 'v1-features', 'v1-integrity', 'v1-quality-policy'].map(n => `packages/prediction/dist/${n}.js`),
  ...['v1-candidate', 'v1-features', 'v1-data', 'v1-release-evidence', 'v1-release-plan',
    'identity', 'research-elo', 'research-evidence', 'temporal', 'game-context', 'dataset', 'dataset-build',
    'roster', 'catalog', 'sample'].map(n => `packages/contracts/dist/${n}.js`),
  ...['v1-data', 'v1-data-repository', 'v1-features', 'v1-release-inventory', 'identity', 'identity-repository',
    'temporal', 'dataset-splits', 'outcome-verifier'].map(n => `packages/db/dist/${n}.js`)
].sort();
const orchestration = ['packages/contracts/dist/v1-runtime.js', 'packages/db/dist/v1-runtime.js',
  'packages/db/dist/v1-runtime-repository.js', 'packages/db/dist/v1-runtime-code.js',
  'packages/db/dist/v1-registry.js', 'packages/db/dist/v1-registry-repository.js'];
export async function readV1RuntimeCode() {
  const root = new URL('../../../', import.meta.url);
  const modules = (await Promise.all(['contracts', 'analytics', 'prediction', 'db'].map(async pkg =>
    (await readdir(new URL(`packages/${pkg}/dist/`, root))).filter(n => n.endsWith('.js')).map(n => `packages/${pkg}/dist/${n}`)))).flat();
  const code = await Promise.all([...new Set([...V1_RUNTIME_KERNEL_PATHS, ...orchestration, ...modules,
    'packages/db/package.json', 'packages/analytics/package.json'])].sort().map(async path =>
    ({ path, sha256: sha(await readFile(new URL(path, root))) })));
  const barrels = await Promise.all(['contracts', 'analytics', 'prediction', 'db'].map(async pkg => {
    const path = `packages/${pkg}/dist/index.js`;
    return { path, text: await readFile(new URL(path, root), 'utf8') };
  }));
  return { policy: 'v1-runtime-kernel-compatibility-v1' as const, code,
    barrels,
    runtime: { node: process.version, platform: process.platform, arch: process.arch,
      nodeBinarySha256: sha(await readFile(process.execPath)) } };
}
export function compatibleV1Runtime(freezeInput: unknown, actual: Awaited<ReturnType<typeof readV1RuntimeCode>>) {
  const freeze = V1ExecutableFreezeSchema.parse(freezeInput);
  const required = freeze.code.filter(c => c.path === 'pnpm-lock.yaml' ||
    /^packages\/(contracts|analytics|prediction|db)\/(dist\/[^/]+\.js|package\.json)$/.test(c.path));
  return Object.entries(freeze.runtime).every(([k, v]) => actual.runtime[k as keyof typeof actual.runtime] === v) &&
    V1_RUNTIME_KERNEL_PATHS.every(path => freeze.code.some(c => c.path === path)) && required.every(({ path }) => {
      const pinned = freeze.code.find(c => c.path === path), current = actual.code.find(c => c.path === path);
      if (path.endsWith('/index.js') && pinned && current) {
        const barrel = actual.barrels.find(b => b.path === path);
        if (!barrel || registryByteHash(barrel.text) !== current.sha256) return false;
        // Allow only additive re-exports of newly introduced modules. All previous exports,
        // import bindings and executable barrel code must retain their exact original bytes.
        const previous = barrel.text.split(/(?<=\n)/).filter(line => {
          const match = /^export (?:\*|\{[^}]+\}) from '(\.\/[^']+\.js)';\r?\n$/.exec(line);
          return !match || freeze.code.some(c => c.path === path.slice(0, -8) + match[1]!.slice(2));
        }).join('');
        return registryByteHash(previous) === pinned.sha256;
      }
      return pinned !== undefined && current !== undefined && pinned.sha256 === current.sha256;
    });
}
const registryByteHash = (text: string) => sha(Buffer.from(text));
