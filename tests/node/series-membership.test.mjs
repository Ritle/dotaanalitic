import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalContextJson} from '../../packages/db/dist/temporal.js';
import {auditSeriesCorpus} from '../../tools/research/series-corpus-core.mjs';
import {valveMembershipSource,auditSeriesMembership} from '../../tools/research/series-membership-core.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const exposure={maps:[],canonicalSeriesKeys:[]};
function fixture(){
  const group={providerSeriesId:'10',existingSeriesId:'local',teamAId:'1',teamBId:'2',leagueId:'3',bestOf:3,reasons:[],mapIds:['100','101'],maps:[true,false].map((radiantIsA,i)=>({
    id:String(100+i),seriesId:'local',isPro:true,ingestState:'accepted',dataRevision:'1',startedAt:`2026-01-01T0${i}:00:00.000Z`,
    radiant:radiantIsA?'1':'2',dire:radiantIsA?'2':'1',externalRadiant:radiantIsA?'1001':'1002',externalDire:radiantIsA?'1002':'1001',externalLeague:'9',
    outcome:{status:'verified',matchId:String(100+i),seriesId:'local',dataRevision:'1',teamAId:radiantIsA?'1':'2',teamBId:radiantIsA?'2':'1',teamAWon:radiantIsA,
      startedAt:`2026-01-01T0${i}:00:00.000Z`,completedAt:`2026-01-01T0${i}:30:00.000Z`,labelVerifiedAt:'2026-01-03T00:00:00.000Z'}}))};
  const raw={info:{league_id:9},series_infos:[{series_id:777,series_type:1,match_ids:['100','101'],team_id_1:1002,team_id_2:1001,start_time:1767225603}],
    node_groups:[{nodes:[],node_groups:[{node_groups:[],nodes:[{node_id:5,series_id:777,node_type:2,team_id_1:1001,team_id_2:1002,team_1_wins:2,team_2_wins:0,
      has_started:true,is_completed:true,actual_time:1767225601,matches:['100','101'].map(match_id=>({match_id,winning_team_id:1001,duration:1800}))}]}]}]};
  return {group,raw};
}
function source(raw){const b=Buffer.from(JSON.stringify(raw)),path='.tools/synthetic-valve.json';return valveMembershipSource(b,{file:path,sha256:sha(b),
  url:'https://www.dota2.com/webapi/IDOTA2League/GetLeagueData/v001?league_id=9&delay_seconds=0',fetchedAt:'2026-01-02T00:00:00.000Z',status:200},path);}
function corpus(group){const p={policyVersion:'reviewed-opendota-series-v3',request:{snapshotAt:'2026-01-03T00:00:00.000Z'},groups:[group],remoteMembershipCompleteness:'unknown',trainingReady:false,deployable:false};
  const plan={...p,fingerprint:sha(canonicalContextJson(p))};return {format:'series-corpus-export-v1',snapshotAt:p.request.snapshotAt,plans:[plan],audit:auditSeriesCorpus([plan],exposure)};}
const run=({group,raw})=>auditSeriesMembership(corpus(group),exposure,[source(raw)]);
const node=x=>x.raw.node_groups[0].node_groups[0].nodes[0];
test('complete source binds by map IDs across different series namespaces; canonical first start is preserved',()=>{
  const r=run(fixture()),x=r.rows[0];assert.equal(r.summary.verifiedSeries,1);assert.equal(x.source.valveSeriesId,'777');assert.equal(x.providerSeriesId,'10');
  assert.equal(x.verifiedSeriesStartAt,'2026-01-01T00:00:00.000Z');assert.notEqual(x.verifiedSeriesStartAt,x.source.reportedNodeStartAt);
  assert.equal(x.winnerTeamId,'1');assert.equal(x.independent,false);assert.equal(x.datasetEligible,false);assert.equal(r.deployable,false);
});
test('complete BO1 and BO5 are supported without borrowing BO3 format or score',()=>{
  const one=fixture();one.group.bestOf=1;one.group.maps.pop();one.group.mapIds.pop();node(one).node_type=1;node(one).team_1_wins=1;node(one).matches.pop();
  one.raw.series_infos[0].series_type=0;one.raw.series_infos[0].match_ids.pop();assert.equal(run(one).summary.verifiedSeries,1);
  const five=fixture();five.group.bestOf=5;const m=structuredClone(five.group.maps[0]);m.id='102';m.startedAt='2026-01-01T02:00:00.000Z';
  m.outcome.matchId=m.id;m.outcome.startedAt=m.startedAt;m.outcome.completedAt='2026-01-01T02:30:00.000Z';five.group.maps.push(m);five.group.mapIds.push(m.id);
  node(five).node_type=3;node(five).team_1_wins=3;node(five).matches.push({match_id:m.id,winning_team_id:1001,duration:1800});
  five.raw.series_infos[0].series_type=2;five.raw.series_infos[0].match_ids.push(m.id);assert.equal(run(five).summary.verifiedSeries,1);
});
test('source and canonical array order do not define the first map',()=>{
  const x=fixture();x.group.maps.reverse();node(x).matches.reverse();x.raw.series_infos[0].match_ids.reverse();
  assert.equal(run(x).rows[0].verifiedSeriesStartAt,'2026-01-01T00:00:00.000Z');
});
test('is_completed with BO5 score 3-2 and only two listed maps is not proof of completeness',()=>{
  const x=fixture();x.group.bestOf=5;node(x).node_type=3;x.raw.series_infos[0].series_type=2;node(x).team_1_wins=3;node(x).team_2_wins=2;
  const r=run(x).rows[0];assert.equal(r.seriesLabelReady,false);assert(r.reasons.includes('SOURCE_SCORE_MAP_COUNT_MISMATCH'));assert.equal(r.verifiedSeriesStartAt,null);
});
test('missing first map cannot move series cutoff to a later loaded map',()=>{
  const x=fixture();node(x).matches.unshift({match_id:'99',winning_team_id:1002,duration:1800});node(x).team_2_wins=1;x.raw.series_infos[0].match_ids.unshift('99');
  const r=run(x).rows[0];assert.deepEqual(r.missingMapIds,['99']);assert.equal(r.verifiedSeriesStartAt,null);
});
test('equal series ID without any native map overlap never binds',()=>{
  const x=fixture();x.raw.series_infos[0].series_id=10;node(x).series_id=10;node(x).matches.forEach((m,i)=>m.match_id=String(200+i));x.raw.series_infos[0].match_ids=['200','201'];
  assert(run(x).rows[0].reasons.includes('MEMBERSHIP_SOURCE_MISSING'));
});
test('source winner must match canonical result with swapped radiant/dire',()=>{
  const x=fixture();node(x).matches[1].winning_team_id=1002;node(x).team_1_wins=1;node(x).team_2_wins=1;
  assert(run(x).rows[0].reasons.includes('CANONICAL_SOURCE_WINNER_MISMATCH'));
});
test('node and series_info lists/formats must agree; duplicates do not make a new map',()=>{
  for(const mutate of [x=>x.raw.series_infos[0].match_ids.pop(),x=>x.raw.series_infos[0].series_type=2,x=>node(x).matches.push({...node(x).matches[0]})]){
    const x=fixture();mutate(x);assert.equal(run(x).summary.verifiedSeries,0);
  }
});
test('extra canonical maps, incomplete nodes, altered teams, duration, and league fail closed',()=>{
  for(const mutate of [x=>{node(x).is_completed=false;},x=>{x.group.maps[0].externalLeague='8';},x=>{x.group.maps[0].externalRadiant='3000';},
    x=>{node(x).matches[0].duration=10;},x=>{x.group.maps[0].id='99';x.group.maps[0].outcome.matchId='99';x.group.mapIds[0]='99';}]){
    const x=fixture();mutate(x);assert.equal(run(x).summary.verifiedSeries,0);
  }
});
test('duplicate overlapping source nodes are ambiguous',()=>{
  const x=fixture();const n=structuredClone(node(x));n.node_id=6;x.raw.node_groups[0].node_groups[0].nodes.push(n);
  assert(run(x).rows[0].reasons.includes('MEMBERSHIP_SOURCE_AMBIGUOUS'));
});
test('source must have been observed after completion and no later than audit snapshot',()=>{
  for(const fetchedAt of ['2025-12-31T00:00:00.000Z','2026-01-04T00:00:00.000Z']){const x=fixture(),s=source(x.raw);s.source.fetchedAt=fetchedAt;
    assert.equal(auditSeriesMembership(corpus(x.group),exposure,[s]).summary.verifiedSeries,0);}
});
test('invalid SHA, unsafe numeric IDs and duplicate node IDs are rejected',()=>{
  assert.throws(()=>valveMembershipSource(Buffer.from('{}'),{file:'x',sha256:'0'.repeat(64)},'x'),/valve_sha/);
  const x=fixture();node(x).matches[0].match_id=9007199254740992;assert.throws(()=>source(x.raw),/unsafe_native_id/);
  const y=fixture();y.raw.node_groups[0].node_groups[0].nodes.push(structuredClone(node(y)));assert.throws(()=>source(y.raw),/duplicate_node/);
});
test('empty/no source inventory never produces a label or training eligibility',()=>{
  const x=fixture();const r=auditSeriesMembership(corpus(x.group),exposure,[]);assert.equal(r.summary.verifiedSeries,0);assert.equal(r.summary.datasetEligibleSeries,0);
});
