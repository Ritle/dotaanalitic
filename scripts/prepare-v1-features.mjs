import { open, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildV1DevelopmentFeatures } from '../packages/db/dist/index.js';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const [mode, source, sourceSha, output, ...extra] = process.argv.slice(2);
if (mode !== 'export' || !source || !/^[a-f0-9]{64}$/.test(sourceSha ?? '') || !output || extra.length) {
  console.error('Использование: prepare-v1-features.mjs export development-dataset.json SHA256 new-features.json');
  process.exit(2);
}
let destination;
try {
  const file = await open(source, 'r');
  let bytes;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 67108864) throw Error('v1_feature_file_limit');
    const buffer = Buffer.alloc(67108865); let size = 0;
    while (size < buffer.length) {
      const part = await file.read(buffer, size, buffer.length - size, null);
      if (!part.bytesRead) break; size += part.bytesRead;
    }
    if (size > 67108864) throw Error('v1_feature_file_limit');
    bytes = buffer.subarray(0, size);
  } finally { await file.close(); }
  if (sha(bytes) !== sourceSha) throw Error('v1_feature_source_sha_mismatch');
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  destination = await open(output, 'wx');
  const result = buildV1DevelopmentFeatures(data);
  const paths = ['scripts/prepare-v1-features.mjs', 'pnpm-lock.yaml'];
  for (const directory of ['packages/contracts/dist', 'packages/db/dist', 'packages/prediction/dist']) {
    for (const name of (await readdir(new URL('../' + directory + '/', import.meta.url))).sort())
      if (name.endsWith('.js')) paths.push(directory + '/' + name);
  }
  const code = await Promise.all(paths.sort().map(async path => ({ path,
    sha256: sha(await readFile(new URL('../' + path, import.meta.url))) })));
  const artifact = { ...result, sourceFileSha256: sourceSha, code };
  const text = JSON.stringify(artifact, null, 2) + '\n';
  if (Buffer.byteLength(text) > 67108864) throw Error('v1_feature_file_limit');
  await destination.writeFile(text, 'utf8'); await destination.sync();
  console.log(JSON.stringify({ status: 'features_prepared', sha256: sha(text), sourceFingerprint: result.sourceFingerprint,
    summary: result.summary, evaluation: result.evaluation, deployable: false, teamAWinProbability: null }));
} catch (error) {
  const allowed = ['v1_feature_file_limit', 'v1_feature_source_sha_mismatch', 'v1_dataset_fingerprint_mismatch',
    'v1_dataset_replay_mismatch', 'v1_synthetic_evidence_forbidden'];
  console.error(JSON.stringify({ status: 'unavailable', code: error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' :
    allowed.includes(error?.message) ? error.message.toUpperCase() : 'V1_FEATURES_FAILED',
    message: 'Признаки не сохранены. Проверьте SHA датасета, составы, доказательства и новое имя выходного файла.' }));
  process.exitCode = 1;
} finally { await destination?.close(); }
