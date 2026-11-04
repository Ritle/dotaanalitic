import {afterAll,beforeAll,beforeEach,expect,test,vi} from 'vitest';
import {sql} from '@dota/db';
import {OpenDotaClient,OpenDotaError,PostgresProviderBudget} from '../src/index.js';
import {testDatabase} from '../../../tests/helpers/postgres.js';

// Synthetic HTTP responses and an isolated PostgreSQL database; no provider traffic.
let fixture:Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async()=>{fixture=await testDatabase();},60000);
afterAll(async()=>{await fixture?.close();},30000);
beforeEach(async()=>{await sql`DELETE FROM provider_quotas`.execute(fixture.db);});

test.each([429,500,502,503,504])('HTTP %s Retry-After persists before a fresh OpenDota client can send HTTP',async status=>{
  const firstFetch=vi.fn(async()=>new Response('synthetic failure',{status,headers:{'Retry-After':'120'}}));
  const first=new OpenDotaClient({attempts:1},{fetch:firstFetch,budget:new PostgresProviderBudget(fixture.db)});
  await expect(first.getProMatches()).rejects.toMatchObject({status,retryAfterMs:120000});
  expect(firstFetch).toHaveBeenCalledTimes(1);

  // Remove local pacing as a possible explanation for a denied permit.
  await sql`UPDATE provider_quotas SET next_request_at='-infinity' WHERE provider='opendota'`.execute(fixture.db);
  const secondFetch=vi.fn(async()=>new Response('[]'));
  const fresh=new OpenDotaClient({attempts:1},{fetch:secondFetch,budget:new PostgresProviderBudget(fixture.db)});
  const failure:unknown=await fresh.getProMatches().catch((error:unknown)=>error);
  expect(failure).toBeInstanceOf(OpenDotaError);
  expect(failure).toMatchObject({code:'source_rate_limited',retryAfterMs:expect.any(Number)});
  expect((failure as OpenDotaError).retryAfterMs).toBeGreaterThan(110000);
  expect(secondFetch).not.toHaveBeenCalled();
  expect((await sql<{used:number}>`SELECT minute_used AS used FROM provider_quotas WHERE provider='opendota'`.execute(fixture.db)).rows[0]!.used).toBe(1);
});
