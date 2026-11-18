import test from 'node:test';
import assert from 'node:assert/strict';
import {CollectionV2RuntimeRequest,collectionV2RuntimeManifestPaths,temporaryCollectionV2Database} from '../../tools/research/conditional-collection-v2-runtime.mjs';
const base={mode:'local-synthetic',ownerId:'11111111-1111-4111-8111-111111111111',registrationId:'22222222-2222-4222-8222-222222222222',registrationSha256:'a'.repeat(64),localOrigin:'http://127.0.0.1:4567'};
test('runtime accepts bounded local input and rejects caller authority, endpoint overrides and scan reset',()=>{
 const r=CollectionV2RuntimeRequest.parse(base);assert.equal(r.maxRequests,5);assert.equal(r.maxDurationMs,60000);
 for(const extra of [{maxRequests:21},{maxRequests:0},{maxDurationMs:60001},{maxDurationMs:99},{endpoint:'/matches/1'},{newScan:true},{collectionAllowed:true}])
  assert.throws(()=>CollectionV2RuntimeRequest.parse({...base,...extra}));
 for(const localOrigin of ['https://api.opendota.com','http://localhost:4567','http://127.0.0.1:4567/a','http://127.0.0.1:4567?api_key=secret'])
  assert.throws(()=>CollectionV2RuntimeRequest.parse({...base,localOrigin}));
});
test('CLI database boundary accepts only local disposable test databases',()=>{
 assert.equal(temporaryCollectionV2Database('postgresql://u:p@127.0.0.1:5432/codex_ingest_123456abcdef').pathname,'/codex_ingest_123456abcdef');
 for(const value of ['postgresql://u:p@example.com/codex_ingest_123456abcdef','postgresql://u:p@localhost/production','file:///tmp/test','invalid'])
  assert.throws(()=>temporaryCollectionV2Database(value));
});
test('new runtime manifest includes all prior v2 boundaries and compiled shared dependencies',async()=>{
 const paths=await collectionV2RuntimeManifestPaths();assert.equal(paths.length,new Set(paths).size);
 for(const p of ['tools/research/conditional-collection-v2-runtime.mjs','tools/research/run-conditional-collection-v2.mjs',
  'tools/research/conditional-collection-v2-discovery.mjs','tools/research/conditional-collection-v2-transport.mjs',
  'packages/db/migrations/069_conditional_collection_v2_transport.sql','packages/contracts/dist/index.js','pnpm-lock.yaml'])assert(paths.includes(p));
});
