import { createDatabase, V1ModelRegistry } from '../packages/db/dist/index.js';
import { V1RegistryTransitionSchema } from '../packages/contracts/dist/index.js';
import { bounded } from './lib/evaluation-discovery-files.mjs';
import { readV1RegistryBundle } from './lib/v1-registry-bundle.mjs';
const [mode, ...args] = process.argv.slice(2);
if (['check', 'register'].includes(mode) ? args.length !== 3 : mode === 'transition' ? args.length !== 2 :
  !['list', 'events', 'readiness'].includes(mode) || args.length) {
  console.error('Использование: check|register bundle-directory CONFIG_SHA FREEZE_SHA | transition request.json REQUEST_SHA | list|events|readiness');
  process.exit(2);
}
let db;
try {
  const artifact = ['check', 'register'].includes(mode) ? await readV1RegistryBundle(...args) : undefined;
  if (mode === 'check') console.log(JSON.stringify({ status: 'registry_bundle_verified', freezeSha256: artifact.freezeSha256,
    registrationPerformed: false, teamAWinProbability: null }));
  else {
    const request = mode === 'transition' ? V1RegistryTransitionSchema.parse((await bounded(args[0], 65536, args[1])).data) : undefined;
    if (!process.env.DATABASE_URL) throw Error('registry_database_required');
    db = createDatabase(process.env.DATABASE_URL); const registry = new V1ModelRegistry(db);
    const result = mode === 'register' ? await registry.register(artifact) : mode === 'transition' ? await registry.transition(request) :
      mode === 'list' ? { models: await registry.list() } : mode === 'events' ? { events: await registry.events() } : await registry.readiness();
    console.log(JSON.stringify({ ...result, teamAWinProbability: null }));
  }
} catch (e) {
  const safe = ['registry_current_changed', 'registry_request_conflict', 'registry_release_not_latest', 'registry_quality_not_passed',
    'registry_release_binding', 'registry_time_gate', 'registry_synthetic_forbidden', 'registry_rollback_target', 'registry_model_missing'];
  console.error(JSON.stringify({ status: 'unavailable', code: safe.includes(e?.message) ? e.message.toUpperCase() : 'V1_REGISTRY_REJECTED',
    message: 'Операция реестра отклонена. Проверьте закреплённую копию, SHA, текущую версию и последний отчёт качества. Повтор с тем же requestId безопасен; смена входов требует нового ID.' }));
  process.exitCode = 1;
} finally { await db?.destroy(); }
