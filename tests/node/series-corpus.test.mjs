import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {canonicalContextJson} from '../../packages/db/dist/temporal.js';
import {auditSeriesCorpus} from '../../tools/research/series-corpus-core.mjs';
const exposure={maps:[],canonicalSeriesKeys:[]};
function group(winners=[true,true],bestOf=3){return {providerSeriesId:'10',existingSeriesId:'local-series',teamAId:'1',teamBId:'2',leagueId:'9',bestOf,reasons:[],
  mapIds:winners.map((_,i)=>String(100+i)),maps:winners.map((win,i)=>({id:String(100+i),seriesId:'local-series',isPro:true,ingestState:'accepted',dataRevision:'1',
    startedAt:`2026-01-01T0${i}:00:00.000Z`,outcome:{status:'verified',matchId:String(100+i),seriesId:'local-series',dataRevision:'1',teamAId:'1',teamBId:'2',teamAWon:win,
      startedAt:`2026-01-01T0${i}:00:00.000Z`,completedAt:`2026-01-01T0${i}:30:00.000Z`,labelVerifiedAt:'2026-01-02T00:00:00.000Z'}}))};}
function plan(groups){const body={policyVersion:'reviewed-opendota-series-v3',request:{snapshotAt:'2026-01-02T00:00:00.000Z'},groups,remoteMembershipCompleteness:'unknown',trainingReady:false,deployable:false};
  return {...body,fingerprint:createHash('sha256').update(canonicalContextJson(body)).digest('hex')};}
const audit=(g,e=exposure)=>auditSeriesCorpus([plan([g])],e);
test('observed 2-0 is a terminal score but never completeness, as-of start or independence proof',()=>{
  const r=audit(group());assert.equal(r.summary.terminalObserved,1);assert.equal(r.summary.datasetEligibleSeries,0);
  assert.equal(r.rows[0].verifiedSeriesStartAt,null);assert.equal(r.rows[0].independence,'not_established');assert.equal(r.deployable,false);
});
test('BO1, BO3 and BO5 winning thresholds; BO2 stays excluded',()=>{
  for(const [wins,bo] of [[[false],1],[[false,true,false],3],[[true,false,true,false,true],5]])assert.equal(audit(group(wins,bo)).summary.terminalObserved,1);
  assert.equal(audit(group([true,false],2)).summary.terminalObserved,0);
});
test('incomplete, post-decision and missing canonical maps fail',()=>{
  for(const wins of [[true],[true,false],[true,true,false]])assert.equal(audit(group(wins)).summary.terminalObserved,0);
  const g=group();g.mapIds.push('109');assert(audit(g).rows[0].reasons.includes('CANONICAL_MAP_MISSING'));
});
test('orientation follows verified team IDs, not radiant position or array order',()=>{
  const g=group([true,false,true]);for(const m of g.maps){m.outcome.teamAId='2';m.outcome.teamBId='1';m.outcome.teamAWon=!m.outcome.teamAWon;}
  g.maps.reverse();const r=audit(g).rows[0];assert.equal(r.observedWinnerTeamId,'1');assert.deepEqual(r.observedScore,{teamA:2,teamB:1});
});
test('unknown outcomes, non-pro, mismatched identities and revised maps fail closed',()=>{
  for(const edit of [m=>{m.isPro=null;},m=>{m.outcome={status:'unavailable'};},m=>{m.outcome.teamBId='3';},m=>{m.outcome.dataRevision='2';},m=>{m.seriesId='other';}]){
    const g=group();edit(g.maps[0]);assert.equal(audit(g).summary.terminalObserved,0);
  }
});
test('overlapping maps and completion beyond audit snapshot fail',()=>{
  const g=group();g.maps[0].outcome.completedAt=g.maps[1].startedAt;assert(audit(g).rows[0].reasons.includes('MAPS_OVERLAP'));
  const h=group();h.maps[1].outcome.completedAt='2026-01-03T00:00:00.000Z';assert(audit(h).rows[0].reasons.includes('INVALID_OUTCOME_TIME'));
});
test('any exposed sibling or series excludes entire group from independence',()=>{
  for(const e of [{maps:[{matchId:'100'}],canonicalSeriesKeys:[]},{maps:[],canonicalSeriesKeys:['["opendota","10"]']}]){
    const r=audit(group(),e);assert.equal(r.summary.previouslyExposed,1);assert.equal(r.rows[0].independence,'exposed');
  }
});
test('duplicate series/maps and tampered plans are rejected',()=>{
  const g=group();assert.throws(()=>auditSeriesCorpus([plan([g,g])],exposure),/duplicate_series/);
  const h=group();h.providerSeriesId='11';assert.throws(()=>auditSeriesCorpus([plan([g,h])],exposure),/map_in_multiple_series/);
  const p=plan([g]);p.groups[0].bestOf=1;assert.throws(()=>auditSeriesCorpus([p],exposure),/plan_fingerprint/);
});
test('empty corpus has zero eligible series and no invented winner',()=>{
  const r=auditSeriesCorpus([],exposure);assert.equal(r.summary.terminalObserved,0);assert.deepEqual(r.rows,[]);
});
test('policy separates formats, freezes numerical criteria, and does not register or activate',()=>{
  const p=JSON.parse(readFileSync(new URL('../../tools/research/series-validation-policy.json',import.meta.url),'utf8'));
  assert.equal(p.status,'prepared_not_registered');assert.equal(p.deployable,false);assert.equal(p.collectionAllowed,false);assert.equal(p.activationAllowed,false);
  assert(Object.entries(p.registration).filter(([k])=>k!=='requirement').every(([,v])=>v===null));
  assert.deepEqual(p.candidate.formats,[1,3,5]);assert.equal(p.evaluation.gatePerFormat,true);assert.equal(p.evaluation.minimumSeriesPerFormat,100);
  assert.equal(p.evaluation.maximumBrier,0.245);assert.equal(p.evaluation.maximumLogLoss,0.685);
  assert.equal(p.release.preserveMapSnapshots,true);assert.equal(p.release.requiresExplicitActivation,true);
});
