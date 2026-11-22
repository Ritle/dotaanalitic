import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareRows, scoreRows} from '../../tools/research/score-blast-ix-h2-diagnostic.mjs';
import {bindBlastIxSeries} from '../../tools/research/reconcile-blast-ix-h2-series.mjs';

const models = {models: {
  H1: {status: 'fitted', featureOrder: ['eloLogit'], coefficients: [1], intercept: 0, calibration: {status:'fitted', temperature:1}},
  H2: {status: 'fitted', featureOrder: ['eloLogit','observedHeroPracticeLog90Delta'], coefficients: [1,1], intercept: 0,
    calibration: {status:'fitted', temperature:1}}
}};
const base = {seriesKey:'["opendota","4"]', slotsComplete:true, picksComplete:true, identitiesComplete:true,
  inputs:{eloLogit:1,observedHeroPracticeLog90Delta:1}, reasons:[]};

test('scores identical labelled rows for both candidates, orienting outcomes by side', () => {
  const result = scoreRows([{...base,id:'1',radiantIsTeamA:true}, {...base,id:'2',radiantIsTeamA:false}, {...base,id:'3'}],
    [{id:'1',radiantWon:true},{id:'2',radiantWon:false}], models);
  assert.equal(result.pairedMaps, 2);
  assert.equal(result.pairedObservedSeriesIds, 1);
  assert.equal(result.pairedCoverage, 2/3);
  assert.equal(result.metrics.H1.correct, 2);
  assert.equal(result.metrics.H1.n, result.metrics.H2.n);
  assert(result.deltaLogLossH2MinusH1 < 0);
});

test('retains failed captures in the denominator with null scores for an empty comparable sample', () => {
  const rows = prepareRows({rows:[{match_id:'1',series_id:null}]}, {collected:[],missing:[{id:'1',reason:'source_timeout'}]},
    {}, {mapIds:[],canonicalSeriesKeys:[]});
  const result = scoreRows(rows, [], models);
  assert.equal(result.maps, 1);
  assert.equal(result.pairedMaps, 0);
  assert.equal(result.metrics.H2.logLoss, null);
  assert.deepEqual(result.exclusionReasons, {source_timeout:1});
});

test('refuses to score an exposed series or unknown series', () => {
  const recap = {rows:[{match_id:'1'},{match_id:'2'},{match_id:'3'}]};
  const collected = [{id:'1',seriesId:'9',players:[]},{id:'2',seriesId:'9',players:[]},{id:'3',seriesId:null,players:[]}];
  const rows = prepareRows(recap,{collected,missing:[]}, {}, {mapIds:['1'],canonicalSeriesKeys:[]});
  assert(rows.every(row => row.inputs === null));
  assert(rows[1].reasons.includes('KNOWN_PRIOR_EXPOSURE'));
  assert(rows[2].reasons.includes('TARGET_SERIES_UNKNOWN'));
});

function valveFixture() {
  return {details:{collected:[{id:'1',seriesId:null,radiantTeamId:'45',direTeamId:'32'},
    {id:'2',seriesId:'10',radiantTeamId:'32',direTeamId:'45'}]},
  snapshot:{series:[{seriesId:'10',type:1,maps:['1','2']}],nodes:[{nodeId:'8',seriesId:'10',completed:true,teams:['32','45'],maps:['2','1']}]}};
}

test('binds exact Valve map membership with matching teams and preserves the original capture', () => {
  const f = valveFixture();
  const result = bindBlastIxSeries(f.details,f.snapshot);
  assert.equal(result.bindings.length,1);
  assert.equal(result.collected[0].seriesId,'10');
  assert.equal(result.collected[0].seriesEvidence,'valve_league_series_and_bracket');
  assert.equal(f.details.collected[0].seriesId,null);
});

test('does not bind ambiguous, incomplete, mismatched or conflicting Valve series', () => {
  const variations = [f=>f.snapshot.series.push({...f.snapshot.series[0],seriesId:'11'}),
    f=>{f.snapshot.nodes[0].completed=false;}, f=>{f.snapshot.nodes[0].teams=['32','46'];},
    f=>{f.snapshot.nodes[0].maps=['1','7'];}, f=>{f.details.collected[1].seriesId='11';}];
  for (const change of variations) {
    const f=valveFixture(); change(f);
    assert.deepEqual(bindBlastIxSeries(f.details,f.snapshot).bindings,[]);
  }
});
