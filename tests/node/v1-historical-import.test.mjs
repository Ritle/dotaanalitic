import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareV1Data} from '../../packages/db/dist/v1-data.js';
import {HeroesSchema} from '../../packages/ingestion/dist/opendota/schemas.js';
import {referenceObservation,numericImportReviews,historicalImportProvider,reconcileHistoricalImport,sha} from '../../scripts/lib/v1-historical-import.mjs';
const at='2026-11-06T10:00:00.000Z',observed='2026-11-05T10:00:00.000Z';
const observation=(raw,endpoint)=>({source:{provider:'opendota',endpoint,fetchedAt:observed,knownAt:null,adapterVersion:'opendota-test-v1',payloadSha256:sha(JSON.stringify(raw))},rawBody:JSON.stringify(raw)});
function fixture(){
 const us=t=>String(BigInt(Date.parse(t))*1000n),sid=i=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
 const players=Array.from({length:10},(_,i)=>({playerSlot:i<5?i:i+123,sourceAccountId:String(i+100)}));
 const candidates=Array.from({length:6},(_,i)=>{
  const id=String(i+1),start=new Date(Date.UTC(2026,7,i+1)).toISOString(),end=new Date(Date.parse(start)+1800000).toISOString();
  return {matchId:id,startedAtUs:us(start),endedAtUs:us(end),syncedAtUs:us(observed),dataRevision:'1',isPro:true,ingestState:'accepted',radiantWin:true,
   radiantTeamId:'11',direTeamId:'22',seriesId:sid(i+1),players:structuredClone(players),receiptPlayers:structuredClone(players),seriesSourceMatched:true,facts:[],
   outcome:{status:'verified',matchId:id,outcomeReceiptId:id,teamAId:'11',teamBId:'22',teamAWon:true,startedAt:start,completedAt:end,seriesId:sid(i+1),dataRevision:'1',labelVerifiedAt:at,
    sourceEvidence:{receiptId:id,payloadSha256:'a'.repeat(64),adapterVersion:'synthetic',normalizerVersion:'synthetic',receiptFetchedAt:observed}}};
 });
 const request={schemaVersion:1,profile:'pre-match-player-elo-data-v1',purpose:'development_only',fromAt:'2024-01-01T00:00:00.000Z',toAt:'2026-11-01T00:00:00.000Z',snapshotAt:at,maxMaps:5000};
 const source={request,identityRevision:'1',candidates,aliases:candidates.map((m,i)=>({seriesId:m.seriesId,provider:'opendota',providerSeriesId:String(i+1),teamAId:'11',teamBId:'22'})),
  identities:players.map((p,i)=>({observationId:'proof:'+i,playerId:String(i+1),provider:'opendota',externalAccountId:p.sourceAccountId,status:'verified',eventAt:null,knownAt:observed,fetchedAt:observed,evidenceRef:'synthetic-account',source:'synthetic'})),code:[{path:'synthetic-test.js',sha256:'b'.repeat(64)}],syntheticOnly:true};
 const plan={fingerprint:'c'.repeat(64),syntheticOnly:true,canonicalBaseIds:candidates.slice(0,5).map(m=>m.matchId),maps:[{matchId:'6',payloadSha256:'a'.repeat(64)}],
  historyWindow:{fromAt:request.fromAt,toAt:request.toAt,maxMaps:request.maxMaps},collectionReport:{rows:[{matchId:'6',seriesId:'6',exposureExcluded:false,reasons:['CURRENT_CANONICAL_IDENTITIES_UNVERIFIED','SERIES_NOT_READY']}]}};
 return {source,plan};
}
test('catalogue references bind hash, endpoint and actual fetch clock',()=>{
 const o=observation([{id:1,name:'npc_dota_hero_test',localized_name:'Test'}],'/heroes');
 assert.equal(referenceObservation(o,'/heroes',HeroesSchema,at).data.length,1);
 for(const bad of [{...o,rawBody:'[]'},{...o,source:{...o.source,endpoint:'/leagues'}},{...o,source:{...o.source,fetchedAt:'2100-01-01T00:00:00.000Z'}}])
  assert.throws(()=>referenceObservation(bad,'/heroes',HeroesSchema,at),/reference_binding/);
});
test('numeric account proof uses verified Steam arithmetic, never nickname equality',()=>{
 const registry=observation([{account_id:100,steamid:String(76561197960265728n+100n),name:'same-name'}],'/proPlayers');
 const profile=observation({profile:{account_id:101,steamid:String(76561197960265728n+101n),personaname:'same-name'}},'/players/101');
 const result=numericImportReviews(registry,[{accountId:'101',observation:profile,sha256:sha(profile.rawBody)}],['100','101'],at);
 assert.deepEqual(result.reviews.map(r=>r.accounts[0].accountId),['100','101']);assert.equal(result.reviews[0].source.knownAt,observed);
 const wrong=observation({profile:{account_id:999,steamid:String(76561197960265728n+101n),personaname:'same-name'}},'/players/101');
 assert.equal(numericImportReviews(registry,[{accountId:'101',observation:wrong,sha256:sha(wrong.rawBody)}],['101'],at).rejected.length,1);
});
test('duplicate registry identities are not resolved by selecting a matching nickname',()=>{
 const row={account_id:100,steamid:String(76561197960265728n+100n),name:'same-name'};
 assert.throws(()=>numericImportReviews(observation([row,row],'/proPlayers'),[],['100'],at));
});
test('captured provider serves only reviewed importable maps',async()=>{
 const o=observation({match_id:'1'},'/matches/1'),provider=historicalImportProvider({maps:[{matchId:'1',reasons:[],observation:o},{matchId:'2',reasons:['bad']}],heroes:{},leagues:{}});
 assert.equal(await provider.getMatchSource('1'),o);await assert.rejects(provider.getMatchSource('2'),/outside_plan/);await assert.rejects(provider.getMatchSource('3'),/outside_plan/);
});
test('canonical readiness uses earlier completed history without computing Elo or exposing labels',()=>{
 const f=fixture(),report=reconcileHistoricalImport(f.plan,prepareV1Data(f.source));
 assert.equal(report.summary.readyMaps,1);assert.deepEqual(report.rows[0].priorCanonicalMapsPerPlayer,Array(10).fill(5));
 assert.equal(report.metrics,null);assert.equal(report.evaluationPerformed,false);assert(!JSON.stringify(report).includes('teamAWon'));
});
test('missing target remains in denominator and blocks its whole series',()=>{
 const f=fixture();f.plan.collectionReport.rows.push({matchId:'7',seriesId:'6',exposureExcluded:false,reasons:['DETAIL_MISSING']});
 const report=reconcileHistoricalImport(f.plan,prepareV1Data(f.source));assert.equal(report.summary.targetMaps,2);assert.equal(report.summary.readyMaps,0);
 assert(report.rows[0].reasons.includes('SERIES_NOT_READY'));assert(report.rows[1].reasons.includes('CANONICAL_MAP_MISSING'));
});
test('completion equal to target start does not count as earlier history',()=>{
 const f=fixture(),m=f.source.candidates[4];m.endedAtUs=f.source.candidates[5].startedAtUs;m.outcome.completedAt=f.source.candidates[5].outcome.startedAt;
 const report=reconcileHistoricalImport(f.plan,prepareV1Data(f.source));assert.equal(report.summary.readyMaps,0);assert.equal(report.rows[0].priorCanonicalMapsPerPlayer[0],4);
});
test('foreign inventory, changed source bytes, scope and envelope tampering fail closed',()=>{
 let f=fixture();f.plan.canonicalBaseIds=[];assert.throws(()=>reconcileHistoricalImport(f.plan,prepareV1Data(f.source)),/unexpected_canonical/);
 f=fixture();f.plan.maps[0].payloadSha256='f'.repeat(64);assert.throws(()=>reconcileHistoricalImport(f.plan,prepareV1Data(f.source)),/history_source_binding/);
 f=fixture();f.plan.historyWindow.toAt=at;assert.throws(()=>reconcileHistoricalImport(f.plan,prepareV1Data(f.source)),/dataset_scope/);
 f=fixture();const data=prepareV1Data(f.source);data.source.identityRevision='9';assert.throws(()=>reconcileHistoricalImport(f.plan,data),/fingerprint/);
});
