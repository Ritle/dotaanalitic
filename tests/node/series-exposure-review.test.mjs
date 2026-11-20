import assert from 'node:assert/strict';
import test from 'node:test';
import {reviewedEssenceIIIKeys,reviewedLeagueDiscovery,screenPriorSeries} from '../../tools/research/review-series-exposure.mjs';

test('a known sibling or an OpenDota series ID excludes the whole BO3',()=>{
  const groups=[
    {league:'71',id:'100',type:'1',maps:['1','9007199254740993']},
    {league:'71',id:'101',type:'1',maps:['2','3']},
    {league:'71',id:'102',type:'1',maps:['4','5']},
    {league:'72',id:'103',type:'2',maps:['6','7','8']}
  ];
  const known={mapIds:['9007199254740993'],seriesKeys:['["opendota","101"]','["pandascore","102"]']};
  assert.deepEqual(screenPriorSeries(groups,known),[{
    editionId:'71',
    excluded:[
      {seriesKey:'["opendota","100"]',matchedSeries:false,matchedMaps:['9007199254740993']},
      {seriesKey:'["opendota","101"]',matchedSeries:true,matchedMaps:[]}
    ],
    unresolved:1
  }]);
});

test('no match in the available inventory leaves each edition unresolved',()=>{
  const groups=[
    {league:'71',id:'100',type:'1',maps:['10']},
    {league:'72',id:'101',type:'1',maps:['11']}
  ];
  assert.deepEqual(screenPriorSeries(groups,{mapIds:[],seriesKeys:[]}),[
    {editionId:'71',excluded:[],unresolved:1},
    {editionId:'72',excluded:[],unresolved:1}
  ]);
});

test('edition review excludes all shortlisted series and only records reviewed PandaScore IDs',()=>{
  const review={
    format:'s3-09-essence-iii-first-map-audit-v1',
    registrationAllowed:false,
    evaluationScope:{leagueId:'20486',treatment:'development_only',removedFromFrozenAuditShortlist:['101','102']},
    rows:[{openDotaSeriesId:'101',pandaScoreMatchId:'103'}]
  };
  const keys=reviewedEssenceIIIKeys(review);
  assert.deepEqual(keys,{
    openDota:['["opendota","101"]','["opendota","102"]'],
    pandaScore:['["pandascore","103"]']
  });
  const groups=['101','102','103'].map(seriesId=>({league:'20486',id:seriesId,type:'1',maps:[]}));
  assert.equal(screenPriorSeries(groups,{mapIds:[],seriesKeys:[...keys.openDota,...keys.pandaScore]})[0].unresolved,1);
  assert.throws(()=>reviewedEssenceIIIKeys({...review,rows:[{openDotaSeriesId:'103',pandaScoreMatchId:'103'}]}),
    /outside excluded selection/);
  assert.throws(()=>reviewedEssenceIIIKeys({...review,rows:[...review.rows,...review.rows]}),/duplicate reviewed series/);
});

function syntheticLeagueReport() {
  return {schema_version:1,mode:'live_opendota',generated_at:'2026-10-31T22:00:00Z',cohorts:[{
    league_id:'71',source_evidence:{
      endpoint:'/leagues/71/matches',adapter_version:'opendota-provider-v2',
      fetched_at:'2026-10-31T21:00:00Z',payload_sha256:'a'.repeat(64)
    },matches:[
      {leagueid:'71',match_id:'9007199254740993',series_id:'100',radiant_win:false},
      {leagueid:'71',match_id:'9007199254740994',series_id:'100',radiant_win:true},
      {leagueid:'71',match_id:'9007199254740995',series_id:null,radiant_win:true},
      {leagueid:'71',match_id:'9007199254740996',series_id:'101',radiant_win:null}
    ]
  }]};
}

test('league discovery projects only IDs of rows with observed outcomes',()=>{
  const matches=reviewedLeagueDiscovery(syntheticLeagueReport());
  assert.deepEqual(matches,{
    mapIds:['9007199254740993','9007199254740994','9007199254740995'],
    seriesKeys:['["opendota","100"]']
  });
  const [summary]=screenPriorSeries([{league:'71',id:'102',type:'1',maps:['9007199254740995']}],matches);
  assert.equal(summary.excluded.length,1);
  assert.equal(summary.excluded[0].matchedSeries,false);
});

test('league discovery rejects synthetic or mismatched scope, duplicate maps and future receipts',()=>{
  const report=syntheticLeagueReport();
  assert.throws(()=>reviewedLeagueDiscovery({...report,syntheticOnly:true}),/synthetic league discovery/u);
  const [cohort]=report.cohorts;
  const [first]=cohort.matches;
  cohort.matches.push(first);
  assert.throws(()=>reviewedLeagueDiscovery(report),/duplicate discovery match/u);
  cohort.matches.pop();
  first.leagueid='72';
  assert.throws(()=>reviewedLeagueDiscovery(report),/map outside league/u);
  first.leagueid='71';
  cohort.source_evidence.fetched_at='2026-11-01T00:00:00Z';
  assert.throws(()=>reviewedLeagueDiscovery(report),/later than its report/u);
});
