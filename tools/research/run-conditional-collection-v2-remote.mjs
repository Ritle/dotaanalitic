import {readFile, stat} from 'node:fs/promises';
import {createDatabase} from '../../packages/db/dist/index.js';
import {parseBindingEvidenceJson} from './conditional-tournament-binding-v2.mjs';
import {RemoteCollectionV2, RemoteStepRequest} from './conditional-collection-v2-remote.mjs';

const controller = new AbortController();
const stop = () => controller.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
let db;
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--request') throw Error('request_required');
  if ((await stat(args[1])).size > 16384) throw Error('request_too_large');
  const bytes = await readFile(args[1]);
  if (bytes.length > 16384) throw Error('request_too_large');
  const request = RemoteStepRequest.parse(parseBindingEvidenceJson(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
  if (!process.env.DATABASE_URL) throw Error('database_url_required');
  db = createDatabase(process.env.DATABASE_URL);
  const result = await new RemoteCollectionV2(db).step(request, {signal: controller.signal});
  console.log(JSON.stringify(result));
  if (!['archived', 'resumed', 'already_recorded'].includes(result.status) || result.validationCode
    || (result.status === 'already_recorded' && result.outcome !== 'archived')) process.exitCode = 2;
} catch {
  console.error(JSON.stringify({status: 'blocked', message: 'Проверьте запрос, регистрацию, архив и журнал попыток.'}));
  process.exitCode = 1;
} finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  await db?.destroy();
}
