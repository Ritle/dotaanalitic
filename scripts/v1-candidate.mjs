import { open } from 'node:fs/promises';
import { registerV1Candidate, verifyRegisteredV1Candidate } from '../packages/db/dist/index.js';
import { V1ReleasePlanRequestSchema } from '../packages/contracts/dist/index.js';
import { candidateCodeManifest, candidateSha, readCandidateFile } from './lib/v1-candidate-files.mjs';
const [mode, ...args] = process.argv.slice(2);
if (mode === 'create' ? args.length !== 5 : mode === 'verify' ? args.length !== 6 : true) {
  console.error('Использование: create plan.json SHA256 catalogue.json development.json new-candidate.json | verify candidate.json SHA256 plan.json PLAN_SHA256 catalogue.json development.json');
  process.exit(2);
}
let output;
try {
  const [planPath, planSha, cataloguePath, developmentPath] = mode === 'create' ? args : args.slice(2);
  const plan = await readCandidateFile(planPath, planSha, 4194304);
  const request = V1ReleasePlanRequestSchema.parse(plan.request), now = new Date().toISOString();
  const testStart = request.events.map(e => e.fromAt).sort()[0];
  if (mode === 'create' && now >= testStart) throw Error('candidate_registration_too_late');
  const catalogue = await readCandidateFile(cataloguePath, request.catalogueSha256, 16777216);
  const development = await readCandidateFile(developmentPath, request.developmentDatasetSha256, 67108864);
  const code = await candidateCodeManifest();
  let candidate, artifactSha;
  if (mode === 'create') {
    output = await open(args[4], 'wx');
    candidate = registerV1Candidate(plan, catalogue, development, planSha, code, now);
    const bytes = JSON.stringify(candidate, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > 4194304) throw Error('candidate_file_limit');
    await output.writeFile(bytes, 'utf8'); await output.sync(); artifactSha = candidateSha(bytes);
  } else {
    const saved = await readCandidateFile(args[0], args[1], 4194304);
    candidate = verifyRegisteredV1Candidate(saved, plan, catalogue, development, planSha, code);
    artifactSha = args[1];
  }
  console.log(JSON.stringify({ status: mode === 'create' ? 'inactive_kernel_registered' : 'inactive_kernel_verified',
    fingerprint: candidate.fingerprint, artifactSha256: artifactSha, codeFingerprint: candidate.codeFingerprint,
    kernelRegisteredAt: candidate.registration.kernelRegisteredAt,
    evaluateNotBefore: candidate.registration.evaluateNotBefore, qualityGate: candidate.qualityGate,
    syntheticOnly: candidate.registration.syntheticOnly, isActive: false, deployable: false,
    executableFreezeComplete: false, teamAWinProbability: null }));
} catch (error) {
  const allowed = ['candidate_registration_too_late', 'candidate_source_sha_required', 'candidate_source_sha_mismatch',
    'candidate_file_limit', 'v1_candidate_replay_mismatch', 'v1_candidate_feature_policy_mismatch',
    'v1_candidate_quality_policy_mismatch', 'release_plan_replay_mismatch'];
  console.error(JSON.stringify({ status: 'unavailable', code: error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' :
    allowed.includes(error?.message) ? error.message.toUpperCase() : 'V1_CANDIDATE_REJECTED',
    message: 'Кандидат не зарегистрирован или не подтверждён. Проверьте SHA, источники плана, версию кода, даты и новое имя файла.' }));
  process.exitCode = 1;
} finally { await output?.close(); }
