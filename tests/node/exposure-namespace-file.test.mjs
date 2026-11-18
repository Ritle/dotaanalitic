// Synthetic fixtures only. No working database, provider calls or real source artifacts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha} from '../../tools/research/exposure-ledger-core.mjs';
import {captureNamespaces,verifyNamespaces} from '../../tools/research/exposure-namespace.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),h='a'.repeat(64),stamp='2026-11-14T00:00:00.000Z';
async function setup(){
 const dir=await mkdtemp(resolve(root,'.tools/namespace-test-')),path=n=>relative(root,resolve(dir,n)).replaceAll('\\','/');
 const put=async(n,x,raw=false)=>{const b=raw?x:JSON.stringify(x);await writeFile(resolve(root,path(n)),b);return {path:path(n),sha256:sha(b)};};
 const sources={};
 sources.original=await put('original.json',{input:{sources:[{path:'synthetic-baseline',sha256:h,adapter:'synthetic_test_only',
 rows:[{matchId:'10',seriesKey:null,localSeriesId:null}],standaloneSeriesKeys:[]}]}});
 sources.archive=await put('archive.json',{result:{baseline:{sha256:sources.original.sha256},archiveSources:[],
 extendedLedger:{mapIds:['10'],canonicalSeriesKeys:[]}}});
 sources.queue=await put('queue.json',{source:{sha256:sources.archive.sha256},decisions:[{matchId:'11',status:'unresolved'},{matchId:'12',status:'unresolved'}]});
 const valve={info:{league_id:1},series_infos:[{series_id:3,match_ids:[11]}]};
 sources.valveOld=await put('valve-old.json',valve);sources.valveE1=await put('valve-e1.json',valve);
 const receipt=s=>({file:s.path,sha256:s.sha256,url:'https://www.dota2.com/webapi/IDOTA2League/GetLeagueData/v001?league_id=1',savedAt:stamp});
 sources.valveOldReceipt=await put('valve-old-receipt.json',{sources:[receipt(sources.valveOld)]});
 sources.valveE1Receipt=await put('valve-e1-receipt.json',receipt(sources.valveE1));
 sources.player=await put('player.json',[]);sources.playerProducer=await put('player.mjs','https://api.opendota.com/api player-history-discovery.json',true);
 sources.depth=await put('depth.json',{task:'S2-01/role-owner-check/player-history-depth',live:{runs:[]}});
 sources.depthProducer=await put('depth.mjs','player_history_runs source_audit',true);sources.league=await put('league.json',{leagues:[]});
 const source={provider:'pandascore',endpoint:'/dota2/matches/upcoming?page=1',payloadSha256:h,fetchedAt:stamp};
 const text=JSON.stringify({source,data:[{providerMatchId:'12'}]});
 sources.panda=await put('panda.json',{format:'namespace-pandascore-snapshot-v1',readOnly:true,records:[{kind:'primary',id:'1',
 provider:'pandascore',source_endpoint:source.endpoint,source_payload_sha256:h,source_fetched_at:stamp,recorded_at:stamp,snapshot_text:text,snapshot_sha256:sha(text)}]});
 const code={};for(const p of ['tools/research/exposure-namespace-core.mjs','tools/research/exposure-namespace.mjs','tools/research/exposure-ledger-core.mjs'])
 code[p]=sha(await readFile(resolve(root,p)));
 await put('plan.json',{format:'exposure-namespace-plan-v1',capturedAt:stamp,sources,code,registrationAllowed:false});
 return {path,put,sources};
}
test('end-to-end namespace result retains baseline, adds native maps only and replays exclusively',async()=>{
 const {path}=await setup(),r=await captureNamespaces(path('plan.json'),path('report.json'));
 assert.deepEqual(r.counts,{dota2_native_map:1,pandascore_match:1});assert.equal(r.ledger.maps,2);
 assert.equal((await verifyNamespaces(path('report.json'),r.sha256)).verified,true);
 await assert.rejects(captureNamespaces(path('plan.json'),path('report.json')),e=>e.code==='EEXIST');
 await assert.rejects(verifyNamespaces(path('report.json')),/external_sha_required/);
});
test('source mutation, incorrect external SHA and rehashed result substitution fail',async()=>{
 const {path,put}=await setup(),r=await captureNamespaces(path('plan.json'),path('report.json'));
 await assert.rejects(verifyNamespaces(path('report.json'),'b'.repeat(64)),/source_sha_changed/);
 const report=JSON.parse(await readFile(resolve(root,path('report.json')),'utf8'));report.result.completeGlobalInventory=true;
 const altered=await put('altered.json',report);await assert.rejects(verifyNamespaces(altered.path,altered.sha256),/replay_mismatch/);
 await put('player.json',[{}]);await assert.rejects(verifyNamespaces(path('report.json'),r.sha256),/source_sha_changed/);
});
test('secret paths and parent-hash mismatch fail before a namespace can be admitted',async()=>{
 const {path,put}=await setup();
 await assert.rejects(captureNamespaces('.tools/private-owner/access.json',path('report.json')),/unsafe_path/);
 await assert.rejects(captureNamespaces(path('plan.json'),'../outside.json'),/unsafe_path/);
 const queue=await put('queue.json',{source:{sha256:h},decisions:[]});
 const p=JSON.parse(await readFile(resolve(root,path('plan.json')),'utf8'));p.sources.queue=queue;await put('plan.json',p);
 await assert.rejects(captureNamespaces(path('plan.json'),path('report.json')),/queue_parent_mismatch/);
});
