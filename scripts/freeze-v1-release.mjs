import { open, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { registerV1ExecutableFreeze, verifyV1ExecutableFreeze } from '../packages/db/dist/index.js';
import { readReleaseFiles, verifyReleaseContext, releaseExecutionCode, releaseRuntime } from './lib/v1-release-files.mjs';
import { bounded, sha } from './lib/evaluation-discovery-files.mjs';
const [mode, configPath, configSha, fourth, fifth, sixth, ...extra] = process.argv.slice(2);
if (!configPath || !/^[a-f0-9]{64}$/.test(configSha ?? '') || extra.length ||
  (mode === 'create' ? !fourth || fifth !== undefined : mode === 'verify' ? !fourth || !/^[a-f0-9]{64}$/.test(fifth ?? '') || sixth !== undefined :
    mode === 'bundle' ? !fourth || !/^[a-f0-9]{64}$/.test(fifth ?? '') || !sixth : true)) {
  console.error('Использование: create config.json SHA new-freeze.json | verify config.json SHA freeze.json FREEZE_SHA | bundle config.json SHA freeze.json FREEZE_SHA new-directory'); process.exit(2);
}
let output;
try {
  const context = await verifyReleaseContext(await readReleaseFiles(configPath, configSha));
  const { plan, candidate, files } = context, code = await releaseExecutionCode(), runtime = await releaseRuntime();
  let artifact, bytes;
  if (mode === 'create') {
    artifact = registerV1ExecutableFreeze(plan, candidate, files.planSha256, files.candidateSha256, code, runtime, new Date().toISOString());
    bytes = Buffer.from(JSON.stringify(artifact, null, 2) + '\n');
    output = await open(fourth, 'wx'); await output.writeFile(bytes); await output.sync();
  } else {
    const saved = await bounded(fourth, 4194304, fifth); bytes = saved.bytes;
    artifact = verifyV1ExecutableFreeze(saved.data, plan, candidate, files.planSha256, files.candidateSha256, code, runtime);
    if (artifact.registeredAt > new Date().toISOString()) throw Error('freeze_in_future');
    if (mode === 'bundle') {
      const root = resolve(sixth); await mkdir(root); // Exclusive new directory; never merge or overwrite.
      const save = async (path, content) => {
        const target = resolve(root, path);
        if (!target.startsWith(root + sep)) throw Error('freeze_bundle_path');
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, { flag: 'wx' });
      };
      for (const entry of code) {
        const content = await readFile(new URL('../' + entry.path, import.meta.url));
        if (sha(content) !== entry.sha256) throw Error('freeze_bundle_changed');
        await save(entry.path, content);
      }
      const refs = [['plan', files.planPath, files.planSha256], ['candidate', files.candidatePath, files.candidateSha256],
        ['catalogue', files.cataloguePath, plan.request.catalogueSha256], ['development', files.developmentPath, plan.request.developmentDatasetSha256]];
      for (const [name, path, digest] of refs) await save(`frozen/${name}.json`, (await bounded(path, 67108864, digest)).bytes);
      await save('frozen/executable.json', bytes);
      const bundled = { ...files, planPath: 'frozen/plan.json', candidatePath: 'frozen/candidate.json', cataloguePath: 'frozen/catalogue.json',
        developmentPath: 'frozen/development.json', freeze: { path: 'frozen/executable.json', sha256: sha(bytes) } };
      const configBytes = JSON.stringify(bundled, null, 2) + '\n'; await save('frozen/config.json', configBytes);
      console.log(JSON.stringify({ status: 'executable_bundle_saved', codeFiles: code.length, configSha256: sha(configBytes),
        dependenciesIncluded: false, secretsCopied: false, deployable: false }));
    }
  }
  if (mode !== 'bundle') console.log(JSON.stringify({ status: mode === 'create' ? 'executable_registered' : 'executable_verified',
    artifactSha256: sha(bytes), fingerprint: artifact.fingerprint, registeredAt: artifact.registeredAt,
    codeFiles: code.length, executableFreezeComplete: true, releaseGatePassed: false, deployable: false }));
} catch (e) {
  const safe = ['freeze_registration_window', 'freeze_replay_mismatch', 'freeze_kernel_code_missing', 'freeze_in_future', 'freeze_bundle_changed'];
  console.error(JSON.stringify({ status: 'unavailable', code: e?.code === 'EEXIST' ? 'OUTPUT_EXISTS' :
    safe.includes(e?.message) ? e.message.toUpperCase() : 'EXECUTABLE_FREEZE_REJECTED',
    message: 'Регистрация или проверка кода отклонена. Проверьте дату, версию Node, SHA плана/кандидата и новый путь. Частичный bundle не использовать.' })); process.exitCode = 1;
} finally { await output?.close(); }
