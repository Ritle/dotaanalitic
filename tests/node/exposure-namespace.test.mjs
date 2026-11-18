import {test} from 'node:test';
import assert from 'node:assert/strict';
import {valveProjection,playerDiscoveryProjection,depthProjection,leagueSummaryProjection,pandascoreProjection,reconcileNamespaces} from '../../tools/research/exposure-namespace-core.mjs';
import {sha} from '../../tools/research/exposure-ledger-core.mjs';
const stamp='2026-11-14T00:00:00.000Z',h='a'.repeat(64);
const valve=()=>{const b=Buffer.from(JSON.stringify({info:{league_id:1},series_infos:[{series_id:3,match_ids:[10,10,0]}]}));
 return {b,r:{file:'v.json',url:'https://www.dota2.com/webapi/IDOTA2League/GetLeagueData/v001?league_id=1',sha256:sha(b),savedAt:stamp}};};
test('Valve native maps are deduplicated but Valve series do not become OpenDota aliases',()=>{
 const {b,r}=valve(),p=valveProjection(b,r,'v.json');assert.deepEqual(p.rows,[{matchId:'10',seriesKey:null,localSeriesId:null}]);
 assert.equal(p.valveSeries[0].provider,'valve');assert.equal(p.valveSeries[0].providerSeriesId,'3');
});
test('Valve checksum, official origin and league identity must agree',()=>{
 const {b,r}=valve();assert.throws(()=>valveProjection(b,{...r,sha256:h},'v.json'),/valve_sha/);
 assert.throws(()=>valveProjection(b,{...r,url:r.url.replace('www.dota2.com','example.com')},'v.json'));
 assert.throws(()=>valveProjection(b,{...r,url:r.url.replace('league_id=1','league_id=2')},'v.json'),/valve_league/);
});
test('unsafe native IDs and empty/zero IDs are never invented',()=>{
 const {r}=valve(),b=Buffer.from(JSON.stringify({info:{league_id:1},series_infos:[{series_id:3,match_ids:[9007199254740992]}]}));
 assert.throws(()=>valveProjection(b,{...r,sha256:sha(b)},'v.json'),/unsafe_id/);
});
const producer='https://api.opendota.com/api player-history-discovery.json';
test('legacy normalized discovery is labelled distinctly from raw verification',()=>{
 const p=playerDiscoveryProjection([{account:'5',status:200,endpoint:'/players/5/matches?lobby_type=1',fetchedAt:stamp,sha256:h,data:[{match_id:10}]}],producer);
 assert.match(p.basis,/not_raw_reverified/);assert.equal(p.rows[0].seriesKey,null);
 assert.throws(()=>playerDiscoveryProjection([],''),/producer_binding/);
 assert.throws(()=>playerDiscoveryProjection([{account:'5',status:200,endpoint:'/players/5/matches?lobby_type=7',fetchedAt:stamp,sha256:h,data:[]}],producer),/wrong_history_scope/);
});
test('history audit accepts its mixed native reference/detail sources and needs explorer evidence',()=>{
 const source=endpoint=>({endpoint,payloadSha256:h,fetchedAt:stamp});
 const x={task:'S2-01/role-owner-check/player-history-depth',live:{runs:[{status:'completed',source_audit:{
 sources:['/explorer?sql=fixed','/heroes','/leagues','/matches/10'].map(source),discoveryRows:[{match_id:'10'},{match_id:'10'}]}}]}};
 assert.equal(depthProjection(x,'player_history_runs source_audit').rows.length,1);
 x.live.runs[0].source_audit.sources=[source('/heroes')];assert.throws(()=>depthProjection(x,'player_history_runs source_audit'),/missing_explorer/);
});
test('normalized league first-row binding rejects mismatched league and preserves unknown series',()=>{
 const x={leagues:[{leagueId:'1',source:{provider:'opendota',endpoint:'/leagues/1/matches',payloadSha256:h,fetchedAt:stamp},first:{match_id:'10',leagueid:'1',series_id:0}}]};
 assert.equal(leagueSummaryProjection(x).rows[0].seriesKey,null);
 x.leagues[0].first.leagueid='2';assert.throws(()=>leagueSummaryProjection(x),/league_row_mismatch/);
});
const source=(path,ids)=>({path,sha256:h,adapter:'synthetic_unit_only',rows:ids.map(matchId=>({matchId,seriesKey:null,localSeriesId:null})),standaloneSeriesKeys:[]});
const baseline={mapIds:['10'],canonicalSeriesKeys:[],sources:[source('baseline',['10'])]};
const panda=n=>({provider:'pandascore',providerMatchId:n,snapshotSha256:h});
test('native maps and PandaScore meeting IDs remain disjoint; baseline provenance survives',()=>{
 const r=reconcileNamespaces({pending:['11','12'],baseline,nativeSources:[source('native',['11'])],pandaEvidence:[panda('12')],capturedAt:stamp});
 assert.deepEqual(r.counts,{dota2_native_map:1,pandascore_match:1});assert.deepEqual(r.ledger.mapIds,['10','11']);
 assert.equal(r.referenceNamespaceComplete,true);assert.equal(r.completeGlobalInventory,false);assert.equal(r.registrationAllowed,false);
});
test('cross-namespace collision and unresolved ID prevent namespace closure',()=>{
 const r=reconcileNamespaces({pending:['11','12'],baseline,nativeSources:[source('native',['11'])],pandaEvidence:[panda('11')],capturedAt:stamp});
 assert.equal(r.decisions[0].namespace,'conflict');assert.equal(r.decisions[1].namespace,'unresolved');
 assert.equal(r.referenceNamespaceComplete,false);assert.deepEqual(r.ledger.mapIds,['10']);
});
test('extra observed maps do not expand beyond the reviewed queue and duplicate queue IDs fail',()=>{
 const input={pending:['11'],baseline,nativeSources:[source('native',['11','99'])],pandaEvidence:[],capturedAt:stamp};
 assert.deepEqual(reconcileNamespaces(input).ledger.mapIds,['10','11']);
 assert.throws(()=>reconcileNamespaces({...input,pending:['11','11']}));
});
test('PandaScore namespace is established by a bound snapshot, never the ID magnitude',()=>{
 const snapshot={data:[{providerMatchId:'9007199254740993'}],source:{provider:'pandascore',endpoint:'/dota2/matches/upcoming?page=1',payloadSha256:h,fetchedAt:stamp}};
 const text=JSON.stringify(snapshot),record={kind:'primary',id:'1',provider:'pandascore',snapshot_text:text,snapshot_sha256:sha(text),
 source_endpoint:snapshot.source.endpoint,source_payload_sha256:h,source_fetched_at:stamp,recorded_at:stamp};
 const input={format:'namespace-pandascore-snapshot-v1',readOnly:true,records:[record]};
 assert.equal(pandascoreProjection(input)[0].providerMatchId,'9007199254740993');
 assert.throws(()=>pandascoreProjection({...input,records:[{...record,snapshot_sha256:'b'.repeat(64)}]}),/panda_snapshot_sha/);
 assert.throws(()=>pandascoreProjection({...input,records:[{...record,recorded_at:'2020-01-01T00:00:00Z'}]}),/panda_clock/);
});
