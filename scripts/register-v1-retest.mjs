import { createDatabase, RetestModelRegistry } from '../packages/db/dist/index.js';
import { readRetestRegistryBundle } from './lib/v1-retest-registry-bundle.mjs';
import { verifyRetestRegistryEvidence } from './lib/v1-retest-registry-verifier.mjs';
const [mode, ...args] = process.argv.slice(2), isSha = s => /^[a-f0-9]{64}$/.test(s ?? '');
if (!(['check','register'].includes(mode) && args.length === 4 && args.slice(1).every(isSha) ||
  mode === 'list' && !args.length || mode === 'verify' && args.length === 1 && /^[a-f0-9-]{36}$/i.test(args[0]))) {
  console.error('Использование: check|register BUNDLE FREEZE_SHA INPUT_SHA REPORT_SHA | list | verify MODEL_ID');process.exit(2);
}
let db;
try {
  const input = ['check','register'].includes(mode) ? await readRetestRegistryBundle(...args) : null;
  // register performs the same replay inside the repository before its first SQL transaction.
  const metadata = mode === 'check' ? await verifyRetestRegistryEvidence(input) : null;
  if (mode === 'check') console.log(JSON.stringify({ status: 'retest_registration_verified', metadata, isActive: false, teamAWinProbability: null }));
  else {
    if (!process.env.DATABASE_URL) throw Error('retest_registry_database_required');
    db = createDatabase(process.env.DATABASE_URL);const registry = new RetestModelRegistry(db);
    const result = mode === 'register' ? await registry.register(input) : mode === 'verify' ? await registry.verify(args[0]) : await registry.list();
    console.log(JSON.stringify(result));
  }
} catch (e) {
  console.error(JSON.stringify({ status: 'unavailable', code: /^retest_registry_[a-z_]+$/.test(e?.message ?? '') ? e.message.toUpperCase() : 'RETEST_REGISTRY_REJECTED',
    message: 'Проверка остановлена. Проверьте SHA, исходный retest, runtime и миграции. Состояние активации не изменено.', teamAWinProbability: null }));
  process.exitCode = 1;
} finally { await db?.destroy(); }
