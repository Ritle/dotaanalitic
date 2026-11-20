import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {reviewSeriesRegistration} from '../../tools/research/review-series-registration.mjs';

const policy=JSON.parse(await readFile(new URL('../../tools/research/series-validation-policy.json',import.meta.url),'utf8'));
const cli=fileURLToPath(new URL('../../tools/research/review-series-registration.mjs',import.meta.url));
const planPath=fileURLToPath(new URL('../../tools/research/series-bo3-registration-plan.json',import.meta.url));
const root=new URL('../../',import.meta.url);
const checkedAt='2026-11-19T02:00:00Z';
const windowStart='2026-11-20T00:00:00Z';
const windowEnd='2026-11-29T00:00:00Z';

const fixture=()=>{
  const rows=['880','881'].map(id=>({
    id,leagueId:'72',from:windowStart,until:'2026-11-28T23:00:00Z',
    stages:[{id:'9'+id,name:'Synthetic stage',from:windowStart,until:'2026-11-28T23:00:00Z'}]
  }));
  const catalog={format:'pandascore-edition-metadata-audit-v1',results:[{
    complete:true,pages:[{fetchedAt:checkedAt}],rows
  }]};
  const plan={format:'bo3-prospective-scope-plan-v1',editions:rows.map(row=>({
    name:'Synthetic '+row.id,organizerSource:'https://example.test',windowStart,windowEnd,plannedBo3:50,
    binding:{leagueId:row.leagueId,editionId:row.id,stageIds:[row.stages[0].id],catalogPath:'synthetic.json'}
  }))};
  const evidence=new Map();
  const review=(asOf=checkedAt,bytes=Buffer.from(JSON.stringify(catalog)))=>{
    const catalogSha256=createHash('sha256').update(bytes).digest('hex');
    for(const edition of plan.editions) edition.binding.catalogSha256=catalogSha256;
    return reviewSeriesRegistration(plan,policy,asOf,async path=>
      path==='synthetic.json' ? Buffer.from(JSON.stringify(catalog)) : evidence.get(path)??readFile(new URL(path,root)));
  };
  return {plan,rows,catalog,review,evidence};
};

test('ordinary CLI reports the real candidate scope and the missing edition',()=>{
  const report=JSON.parse(execFileSync(process.execPath,[cli,planPath,checkedAt],{encoding:'utf8',timeout:15000}));
  assert.equal(report.scopeReady,false);
  assert.equal(report.reviewBefore,'2026-11-19T23:00:00.000Z');
  assert.equal(report.remainingMs,21*60*60*1000);
  assert.deepEqual(report.editions.map(edition=>[edition.editionId,edition.stages.length,edition.issues]),[
    ['11187',7,[]],[null,0,['MAIN_EDITION_ID_UNCONFIRMED']]
  ]);
  assert.deepEqual(report.plannedBo3,{total:105,fromVerifiedEditions:33,minimumEligible:100,minimumCoverage:0.8,
    minimumEditions:2});
  assert.deepEqual(report.capacity,{minimumEligibleAtPlannedVolume:100,minimumCoverageAtPlannedVolume:100/105,
    maximumUnavailableAtPlannedVolume:5,planningTargetAtMinimumCoverage:125,extraPlannedToTarget:20});
  assert.equal(report.policyStatus,'prepared_not_registered');
  assert.equal(report.collectionAllowed,false);
  assert(report.pendingRegistration.includes('candidateManifestSha256'));
  assert.deepEqual(report.registrationIssues,['EDITION_SCOPE_UNCONFIRMED','EXPOSURE_INVENTORY_INCOMPLETE']);
  assert.equal(report.exposure.status,'partial');
  assert.equal(report.exposure.knownMapCount,2285);
  assert.equal(report.exposure.knownSeriesCount,1145);
  assert.equal(report.exposure.prospectiveStatus,'not_screened');
  assert.deepEqual(report.exposure.historicalWallachia.map(({unresolved,excluded})=>[unresolved,excluded.length]),
    [[47,0],[46,0],[46,0]]);
});

test('a verified 100-BO3 synthetic plan passes scope review strictly before its window',async()=>{
  const {plan,review}=fixture();
  const report=await review();
  assert.equal(report.scopeReady,true);
  assert.deepEqual(report.registrationIssues,['EXPOSURE_INVENTORY_MISSING']);
  assert.deepEqual((await review(windowStart)).issues,['SCOPE_WINDOW_STARTED']);
  plan.editions[1].plannedBo3=49;
  assert.deepEqual((await review()).issues,['PLANNED_BO3_BELOW_MINIMUM']);
  plan.editions.pop();
  assert.deepEqual((await review()).issues,['TOO_FEW_EDITIONS','PLANNED_BO3_BELOW_MINIMUM']);
});

test('capacity applies both count and coverage floors and keeps impossible ratios unknown',async()=>{
  const {plan,review}=fixture();
  plan.editions[1].plannedBo3=78;
  const enough=await review();
  assert.deepEqual(enough.capacity,{minimumEligibleAtPlannedVolume:103,minimumCoverageAtPlannedVolume:103/128,
    maximumUnavailableAtPlannedVolume:25,planningTargetAtMinimumCoverage:125,extraPlannedToTarget:0});
  plan.editions[1].plannedBo3=null;
  const insufficient=await review();
  assert.equal(insufficient.capacity.minimumCoverageAtPlannedVolume,null);
  assert.equal(insufficient.capacity.maximumUnavailableAtPlannedVolume,null);
  plan.editions[0].plannedBo3=null;
  const unknown=await review();
  assert.equal(unknown.capacity.minimumCoverageAtPlannedVolume,null);
  assert.equal(unknown.capacity.extraPlannedToTarget,125);
});

test('one exposed map excludes its entire historical series in the registration report',async()=>{
  const {plan,review,evidence}=fixture();
  const savedPlan=JSON.parse(await readFile(planPath,'utf8'));
  const inventory={format:'series-exposure-review-v1',capturedAt:checkedAt,completeGlobalInventory:false,
    registrationAllowed:false,mapIds:['8205206446'],seriesKeys:['["pandascore","955790"]']};
  const bytes=Buffer.from(JSON.stringify(inventory));
  evidence.set('inventory.json',bytes);
  plan.exposure={
    inventory:{path:'inventory.json',sha256:createHash('sha256').update(bytes).digest('hex')},
    historicalWallachia:savedPlan.exposure.historicalWallachia
  };
  const report=await review();
  assert.equal(report.scopeReady,true);
  assert.deepEqual(report.registrationIssues,['EXPOSURE_INVENTORY_INCOMPLETE']);
  assert.deepEqual(report.exposure.historicalWallachia[0],{
    editionId:'17891',unresolved:46,excluded:[
      {seriesKey:'["opendota","955788"]',matchedSeries:false,matchedMaps:['8205206446']}
    ]
  });
  const earlier=await review('2026-11-19T01:59:59Z');
  assert.equal(earlier.exposure.status,'unavailable_as_of');
  assert(earlier.registrationIssues.includes('EXPOSURE_INVENTORY_FROM_FUTURE'));
  const altered=Buffer.from(JSON.stringify({...inventory,completeGlobalInventory:true}));
  evidence.set('inventory.json',altered);
  await assert.rejects(review(),/evidence digest mismatch/);
  plan.exposure.inventory.sha256=createHash('sha256').update(altered).digest('hex');
  await assert.rejects(review(),/completeGlobalInventory/);
});

test('qualification outside the window, wrong league and missing stage block scope review',async()=>{
  const {rows,review}=fixture();
  rows[0].from='2026-10-13T00:00:00Z';
  rows[0].leagueId='73';
  rows[0].stages=[];
  const report=await review();
  assert.equal(report.scopeReady,false);
  assert.deepEqual(report.editions[0].issues,['LEAGUE_ID_MISMATCH','STAGE_IDS_MISMATCH','SCHEDULE_OUTSIDE_REVIEWED_WINDOW']);
  assert.equal(report.plannedBo3.fromVerifiedEditions,50);
});

test('later observations and altered bytes cannot confirm a reviewed edition',async()=>{
  const {catalog,review}=fixture();
  catalog.results[0].pages[0].fetchedAt='2026-11-19T02:00:01Z';
  assert.deepEqual((await review()).editions[0].issues,['EDITION_NOT_IN_CATALOG_AS_OF']);
  await assert.rejects(review(checkedAt,Buffer.from('different catalog')),/catalog digest mismatch/);
});
