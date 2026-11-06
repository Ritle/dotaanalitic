import {it,expect} from 'vitest';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../src/index.js';
import {V1DataRepository} from '../src/v1-data-repository.js';
it('exports more than 20,000 provenance facts completely, with the snapshot cutoff and no writes',async()=>{
 const database=await testDatabase();
 try{
  await sql`INSERT INTO matches(id,started_at) SELECT 1000000000+n,'2025-01-01'::timestamptz FROM generate_series(1,20) n`.execute(database.db);
  await sql`INSERT INTO match_field_observations(match_id,field_name,provider,value,fetched_at,adapter_version,value_sha256)
   SELECT 1000000000+m,'synthetic.provenance','synthetic','null'::jsonb,'2025-01-02'::timestamptz,'synthetic-test',repeat('a',64)
   FROM generate_series(1,20) m CROSS JOIN generate_series(1,1001) n`.execute(database.db);
  await sql`INSERT INTO match_field_observations(match_id,field_name,provider,fetched_at,adapter_version,value_sha256)
   VALUES(1000000001,'synthetic.future','synthetic','2100-01-01','synthetic-test',repeat('b',64))`.execute(database.db);
  const snapshotAt=new Date().toISOString(),request={schemaVersion:1,profile:'pre-match-player-elo-data-v1',purpose:'development_only',
   fromAt:'2024-01-01T00:00:00.000Z',toAt:snapshotAt,snapshotAt,maxMaps:25},code=[{path:'synthetic-test.ts',sha256:'a'.repeat(64)}];
  const repo=new V1DataRepository(database.db,true),first=await repo.export(request,code);
  expect(first.source.candidates).toHaveLength(20);
  expect(first.source.candidates.flatMap(m=>m.facts)).toHaveLength(20020);
  expect(first.source.candidates.flatMap(m=>m.facts).some(f=>f.field==='synthetic.future')).toBe(false);
  expect(await repo.export(request,code)).toEqual(first);
  expect((await sql<{n:number}>`SELECT count(*)::integer n FROM match_field_observations`.execute(database.db)).rows[0]!.n).toBe(20021);
 }finally{await database.close();}
},60000);
