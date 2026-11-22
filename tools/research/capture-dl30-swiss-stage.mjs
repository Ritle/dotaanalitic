import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createDatabase, PandaScoreQuotaRepository} from '../../packages/db/dist/index.js';
import {OpenDotaClient, PostgresProviderBudget} from '../../packages/ingestion/dist/index.js';
import {retryAfterMilliseconds} from '../../packages/ingestion/dist/opendota/client.js';
import {DurablePandaScoreBudget} from '../../apps/api/dist/modules/upcoming/service.js';
import {bindingV2Sha as sha} from './conditional-tournament-binding-v2.mjs';
import {endpoints, replayStage} from './review-dl30-swiss-stage.mjs';

const token = process.env.PANDASCORE_API_TOKEN?.trim();
assert(token && process.env.DATABASE_URL, 'pandascore_token_and_database_required');
const directory = join('.tools','s304-dl30-stage-' + Date.now());
await mkdir(directory);
const db = createDatabase(process.env.DATABASE_URL);
const sources = {};
async function save(key, bytes, fetchedAt, meta = {}) {
  await writeFile(join(directory,key), bytes, {flag:'wx'});
  sources[key] = {url:endpoints[key], httpStatus:200, fetchedAt, sha256:sha(bytes), ...meta};
}
async function capture(key, budget) {
  await budget?.beforeRequest();
  const response = await fetch(endpoints[key], {redirect:'error', signal:AbortSignal.timeout(25000),
    headers:budget ? {Authorization:'Bearer ' + token} : {}});
  const remaining = response.headers.get('x-rate-limit-remaining');
  await budget?.observe(response.status,retryAfterMilliseconds(response.headers.get('retry-after'),Date.now()),
    remaining !== null && /^\d+$/.test(remaining) ? Number(remaining) : null);
  assert.equal(response.status,200,key + '_http_' + response.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert(size <= 16 * 1024 * 1024, key + '_byte_limit');
    chunks.push(chunk);
  }
  const headers = response.headers;
  const meta = budget ? {page:{number:headers.get('x-page'), size:headers.get('x-per-page'),
    total:headers.get('x-total'), hasNext:/rel\s*=\s*"?next\b/i.test(headers.get('link') ?? '')}} : {};
  await save(key,Buffer.concat(chunks),new Date().toISOString(),meta);
}
try {
  await capture('calendar');
  await capture('valve');
  const limits = {rpm:Number(process.env.OPENDOTA_RPM_BUDGET ?? 45), daily:Number(process.env.OPENDOTA_DAILY_BUDGET ?? 2000),
    monthly:Number(process.env.OPENDOTA_MONTHLY_BUDGET ?? 45000)};
  const client = new OpenDotaClient({attempts:1, maxRequests:1, timeoutMs:25000, apiKey:process.env.OPENDOTA_API_KEY},
    {budget:new PostgresProviderBudget(db,limits)});
  const observation = await client.getLeagues();
  assert.equal(sha(observation.rawBody),observation.source.payloadSha256,'opendota_capture_hash');
  await save('opendota',observation.rawBody,observation.source.fetchedAt);
  await capture('editions',new DurablePandaScoreBudget(new PandaScoreQuotaRepository(db)));
  await writeFile(join(directory,'sources.json'),JSON.stringify({format:'dl30-swiss-source-capture-v1',sources},null,2),{flag:'wx'});
  const report = await replayStage(directory);
  await writeFile(join(directory,'review.json'),JSON.stringify(report,null,2),{flag:'wx'});
  console.log(JSON.stringify({directory,...report},null,2));
} finally { await db.destroy(); }
