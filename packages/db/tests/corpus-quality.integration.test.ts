import {beforeEach,afterEach,test,expect} from 'vitest';
import {sql} from '../src/index.js';
import {CorpusQualityRepository} from '../src/corpus-quality.js';
import {testDatabase} from '../../../tests/helpers/postgres.js';
let database:Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async()=>{database=await testDatabase();},30000);
afterEach(async()=>{await database?.close();},30000);
const request={fromAt:'2025-01-01T00:00:00.000Z',toAt:'2025-03-01T00:00:00.000Z'};
const read=()=>new CorpusQualityRepository(database.db).report(request);
async function map(id:string,startedAt='2025-01-15T00:00:00.000Z',pro:boolean|null=true){
  await sql`INSERT INTO matches(id,started_at,is_pro) VALUES (${id},${startedAt},${pro})`.execute(database.db);
}
async function quality(id:string,version:string,heroes='eligible',timeline='structurally_inconsistent'){
  await sql`INSERT INTO match_quality_assessments(match_id,validator_version,assessed_at,outcome_status,player_status,
    final_heroes_status,organization_status,series_status,draft_timeline_status,metrics,anomalies)
    VALUES (${id},${version},'2025-04-01T00:00:00Z','eligible','unknown',${heroes},'unknown','unknown',${timeline},
      '{"provider_patch_id":99}'::jsonb,'["SYNTHETIC_EXTRA_PICK","SYNTHETIC_EXTRA_PICK"]'::jsonb)`.execute(database.db);
}
test('one pro map per row, independent hero/timeline quality, newest assessment and missing assessment retained',async()=>{
  await map('9007199254740993');await map('2','2025-02-01T00:00:00.000Z');await map('3',undefined,false);await map('4',undefined,null);
  await quality('9007199254740993','synthetic-v1','ineligible','missing');
  await quality('9007199254740993','synthetic-v2');
  const report=await read();expect(report.status).toBe('complete');if(report.status!=='complete')throw new Error();
  expect(report.summary).toMatchObject({maps:2,assessedMaps:1,linkedReceiptMaps:0,
    dimensions:{heroes:{eligible:1,unknown:1,ineligible:0},timeline:{structurally_inconsistent:1,unknown:1,missing:0,verified:0}},
    anomalies:{SYNTHETIC_EXTRA_PICK:1}});
  expect(report.maps.find(m=>m.matchId==='9007199254740993')).toMatchObject({canonicalPatchId:null,providerPatchId:'99',
    assessment:{validatorVersion:'synthetic-v2',receipt:null}});
  expect(report.strata.canonicalPatch).toHaveLength(1);expect(report.strata.period.map(p=>p.value)).toEqual(['2025-01','2025-02']);
  expect(report).toMatchObject({historicalAvailability:'not_assessed',trainingReady:false,deployable:false});
  expect((await read()).fingerprint).toBe(report.fingerprint);
});
test('date window is inclusive at start and exclusive at end; empty corpus has explicit zero counts',async()=>{
  await map('1',request.fromAt);await map('2',request.toAt);await map('3','2024-12-31T23:59:59.999Z');
  const result=await read();expect(result.status).toBe('complete');if(result.status!=='complete')throw new Error();
  expect(result.maps.map(m=>m.matchId)).toEqual(['1']);
  const empty=await new CorpusQualityRepository(database.db).report({fromAt:'2024-01-01T00:00:00.000Z',toAt:'2024-02-01T00:00:00.000Z'});
  expect(empty).toMatchObject({status:'complete',maps:[],summary:{maps:0,assessedMaps:0},strata:{league:[],period:[]}});
});
test('overflow never returns a silently truncated quality report',async()=>{
  await sql`INSERT INTO matches(id,started_at,is_pro) SELECT n,'2025-01-15T00:00:00Z',true FROM generate_series(1,5001) n`.execute(database.db);
  expect(await read()).toMatchObject({status:'unavailable',reason:'WINDOW_TOO_LARGE',maxMaps:5000});
});
test('invalid or future windows are rejected',async()=>{
  const reader=new CorpusQualityRepository(database.db);
  await expect(reader.report({...request,toAt:request.fromAt})).rejects.toThrow();
  await expect(reader.report({...request,toAt:'2999-01-01T00:00:00.000Z'})).rejects.toThrow('future_window');
});

test('receipt binding allows a reused source snapshot but rejects a receipt of another map',async()=>{
  await map('1');await map('2');
  async function receipt(id:string,context:string){return (await sql<{id:string}>`INSERT INTO provider_ingest_receipts(
    provider,provider_match_id,canonical_match_id,adapter_version,normalizer_version,context_sha256,payload_sha256,
    fetched_at,source_payload,status,reasons) VALUES ('opendota',${id},${id},'synthetic','synthetic',${context.repeat(64)},
    ${'a'.repeat(64)},'2025-04-01T00:00:00Z','{}'::jsonb,'accepted','[]'::jsonb) RETURNING id::text`.execute(database.db)).rows[0]!.id;}
  const first=await receipt('1','b'),next=await receipt('1','c'),other=await receipt('2','d');
  const snapshot=(await sql<{id:string}>`INSERT INTO match_source_snapshots(match_id,provider,provider_match_id,adapter_version,
    fetched_at,payload_sha256,raw_blob_ref) VALUES (1,'opendota','1','synthetic','2025-04-01T00:00:00Z',${'a'.repeat(64)},
    ${'pg:provider_ingest_receipts/'+first}) RETURNING id::text`.execute(database.db)).rows[0]!.id;
  async function assessment(version:string,receiptId:string){await sql`INSERT INTO match_quality_assessments(match_id,source_snapshot_id,
    validator_version,metrics) VALUES (1,${snapshot},${version},${JSON.stringify({receipt_id:receiptId,provider_patch_id:99})}::jsonb)`.execute(database.db);}
  await assessment('synthetic-reused-snapshot',next);
  const good=await read();expect(good.status).toBe('complete');if(good.status!=='complete')throw new Error();
  expect(good.summary.linkedReceiptMaps).toBe(1);expect(good.maps[0]!.assessment!.receipt!.id).toBe(next);
  expect(good.strata.providerPatch.map(p=>p.value)).toContain('opendota:99');
  await assessment('synthetic-wrong-map',other);
  const bad=await read();expect(bad.status).toBe('complete');if(bad.status!=='complete')throw new Error();
  expect(bad.summary).toMatchObject({maps:2,assessedMaps:1,linkedReceiptMaps:0});
  expect(bad.maps[0]!.assessment!.receipt).toBeNull();expect(bad.fingerprint).not.toBe(good.fingerprint);
});
