import { realpath } from 'node:fs/promises';
import { resolve, sep, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { V1ReleaseFilesSchema, V1CandidateRegistrationSchema } from '../../packages/contracts/dist/index.js';
import { verifyV1ReleasePlan, verifyRegisteredV1Candidate, verifyV1ExecutableFreeze, verifyV1RegistryArtifact } from '../../packages/db/dist/index.js';
import { bounded } from './evaluation-discovery-files.mjs';
import { releaseExecutionCode, releaseRuntime } from './v1-release-files.mjs';
/** Read only: never import or execute JS from the supplied bundle directory. */
export async function readV1RegistryBundle(directory, configSha256, freezeSha256) {
  const root = await realpath(directory);
  const local = async path => {
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw Error('registry_bundle_path');
    const target = await realpath(resolve(root, path));
    if (!target.startsWith(root + sep)) throw Error('registry_bundle_path');
    return target;
  };
  const config = V1ReleaseFilesSchema.parse((await bounded(await local('frozen/config.json'), 65536, configSha256)).data);
  if (!config.freeze || config.freeze.sha256 !== freezeSha256) throw Error('registry_bundle_freeze_required');
  const planFile = await bounded(await local(config.planPath), 4194304, config.planSha256);
  const catalogue = await bounded(await local(config.cataloguePath), 16777216, planFile.data.request.catalogueSha256);
  const development = await bounded(await local(config.developmentPath), 67108864, planFile.data.request.developmentDatasetSha256);
  const plan = verifyV1ReleasePlan(planFile.data, catalogue.data, development.data);
  const candidateFile = await bounded(await local(config.candidatePath), 4194304, config.candidateSha256);
  const registration = V1CandidateRegistrationSchema.parse(candidateFile.data.registration);
  const candidate = verifyRegisteredV1Candidate(candidateFile.data, plan, catalogue.data, development.data, config.planSha256, registration.code);
  const freezeFile = await bounded(await local(config.freeze.path), 4194304, freezeSha256);
  const rootUrl = pathToFileURL(root + sep), code = await releaseExecutionCode(rootUrl);
  for (const entry of code) await local(entry.path);
  const freeze = verifyV1ExecutableFreeze(freezeFile.data, plan, candidate, config.planSha256, config.candidateSha256, code, await releaseRuntime());
  if (freeze.registeredAt > new Date().toISOString()) throw Error('registry_time_gate');
  const artifact = { planText: planFile.bytes.toString('utf8'), planSha256: config.planSha256,
    candidateText: candidateFile.bytes.toString('utf8'), candidateSha256: config.candidateSha256,
    freezeText: freezeFile.bytes.toString('utf8'), freezeSha256 };
  verifyV1RegistryArtifact(artifact);
  return artifact;
}
