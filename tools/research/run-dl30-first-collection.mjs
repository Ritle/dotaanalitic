import {createDatabase} from '../../packages/db/dist/index.js';
import {collectDl30FirstLeague} from './dl30-first-collection.mjs';

let db;
const controller = new AbortController();
const stop = () => controller.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  const [registrationSha256, operationId, ...extra] = process.argv.slice(2);
  if (extra.length || !registrationSha256 || !operationId || !process.env.DATABASE_URL) {
    throw Error('usage: run-dl30-first-collection.mjs <registrationSha256> <operationId>');
  }
  db = createDatabase(process.env.DATABASE_URL);
  const result = await collectDl30FirstLeague(db, {registrationSha256, operationId}, {signal: controller.signal});
  console.log(JSON.stringify(result));
  if (result.status !== 'archived' || result.validationCode) process.exitCode = 2;
} catch {
  console.error(JSON.stringify({status: 'blocked', message: 'Проверьте SHA регистрации, UUID операции и состояние журнала. Повторите с тем же UUID.'}));
  process.exitCode = 1;
} finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  await db?.destroy();
}
