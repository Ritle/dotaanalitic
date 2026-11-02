import { open, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export const candidateSha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function readCandidateFile(path, expectedSha, limit) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha ?? '')) throw Error('candidate_source_sha_required');
  const file = await open(path, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) throw Error('candidate_file_limit');
    const bytes = Buffer.alloc(limit + 1); let count = 0;
    while (count < bytes.length) {
      const part = await file.read(bytes, count, bytes.length - count, null);
      if (!part.bytesRead) break; count += part.bytesRead;
    }
    if (count > limit) throw Error('candidate_file_limit');
    const content = bytes.subarray(0, count);
    if (candidateSha(content) !== expectedSha) throw Error('candidate_source_sha_mismatch');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
  } finally { await file.close(); }
}

/** Own allowlist, never filesystem paths supplied by an untrusted artifact. */
export async function candidateCodeManifest() {
  const paths = ['scripts/v1-candidate.mjs', 'scripts/lib/v1-candidate-files.mjs', 'pnpm-lock.yaml', 'package.json',
    'packages/prediction/package.json', 'packages/db/package.json', 'packages/contracts/package.json'];
  for (const directory of ['packages/prediction/dist', 'packages/contracts/dist', 'packages/db/dist']) {
    for (const name of (await readdir(new URL('../../' + directory + '/', import.meta.url))).sort())
      if (name.endsWith('.js')) paths.push(directory + '/' + name);
  }
  return Promise.all(paths.sort().map(async path => ({ path,
    sha256: candidateSha(await readFile(new URL('../../' + path, import.meta.url))) })));
}
