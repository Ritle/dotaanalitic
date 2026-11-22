import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {endpoints, readStageSources, reviewStage} from '../../tools/research/review-dl30-swiss-stage.mjs';
import {sample, stage} from '../fixtures/dl30-swiss-stage.mjs';

const proposal = JSON.parse(await readFile(new URL('../../tools/research/player-hero-dl30-swiss-proposal.json',import.meta.url)));
const now = '2026-11-22T12:00:00.000Z';
const review = input => reviewStage(input,proposal,now);
test('combined Swiss stage and conservative local date bound, no receipt or activation',() => {
  const report = review(sample());
  assert.deepEqual(report.reasons,[]);
  assert.deepEqual(report.binding,{openDotaLeagueId:'100',pandaScoreEditionId:'123',stages:[{id:'456',round:null}]});
  assert.equal(report.firstSeriesStartLowerBound,'2026-12-01T10:00:00.000Z');
  assert.equal(report.registrationPerformed,false);
  assert.equal(report.activationAllowed,false);
});
test('six explicit rounds ordered without published pairings, extra tiebreaker excluded',() => {
  const data = sample();
  data.editions[0].tournaments = [stage(100,'Swiss Tiebreaker'),...[6,5,4,3,2,1].map(n => stage(n,'Swiss Round '+n))];
  assert.deepEqual(review(data).binding.stages.map(s => s.round),[1,2,3,4,5,6]);
});
for (const [name,change,reason] of [
  ['qualifier named in slug', d => {d.editions[0].slug += '-qualifier';}, 'MAIN_EDITION_UNVERIFIED'],
  ['playoffs alone', d => d.editions[0].tournaments.shift(),'SWISS_STAGE_IDS_UNVERIFIED'],
  ['excluded league', d => {d.valve.infos[0].league_id=20359;d.opendota[0].leagueid=20359;}, 'MAIN_LEAGUE_UNVERIFIED'],
  ['same numeric ID reused',d => d.opendota.push({...d.opendota[0],name:'Division 2'}),'MAIN_LEAGUE_UNVERIFIED'],
  ['mismatched OpenDota ID', d => {d.opendota[0].leagueid=101;},'MAIN_LEAGUE_UNVERIFIED'],
  ['ambiguous Valve row',d => d.valve.infos.push({...d.valve.infos[0],league_id:111}),'MAIN_LEAGUE_UNVERIFIED'],
  ['wrong stage parent',d => {d.editions[0].tournaments[0].serie_id=555;},'SWISS_STAGE_IDS_UNVERIFIED'],
  ['same stage also listed under qualifier',d => {
    d.editions.push({...d.editions[0],id:125,name:'Closed Qualifier',tournaments:[{...stage(456,'Group'),serie_id:125}]});
    d.page.total='2';
  },'STAGE_ID_IN_OTHER_EDITION'],
  ['missing rounds',d => {d.editions[0].tournaments=[stage(9,'Swiss Round 1')];},'SWISS_STAGE_IDS_UNVERIFIED'],
  ['mixed round encodings',d => d.editions[0].tournaments.push(stage(9,'Swiss Round 1')),'SWISS_STAGE_IDS_UNVERIFIED'],
  ['wrong year',d => {d.editions[0].year=2025;},'MAIN_EDITION_UNVERIFIED'],
  ['earlier competition',d => {d.editions[0].begin_at='2026-11-05T10:00:00Z';},'EDITION_CALENDAR_CONFLICT'],
  ['missing timezone',d => {d.editions[0].tournaments[0].begin_at='2026-12-02T10:00:00';},'STAGE_CALENDAR_CONFLICT'],
  ['stage starts after playoffs begin',d => {d.editions[0].tournaments[0].begin_at='2026-12-10T10:00:00Z';},'STAGE_CALENDAR_CONFLICT'],
  ['unseen page',d => {d.page.total='2';},'EDITION_PAGE_INCOMPLETE'],
  ['link to subsequent page',d => {d.page.hasNext=true;},'EDITION_PAGE_INCOMPLETE'],
  ['duplicate edition IDs',d => {d.editions.push(d.editions[0]);d.page.total='2';},'EDITION_PAGE_INCOMPLETE'],
  ['changed format',d => {d.calendar=d.calendar.replace('6 swiss','5 swiss');},'ESL_SWISS_CALENDAR_UNVERIFIED'],
  ['different season',d => {d.calendar=d.calendar.replace('Season 30','Season 300');},'ESL_SWISS_CALENDAR_UNVERIFIED'],
]) test(name,() => {
  const data=sample(); change(data);
  const report=review(data);
  assert.equal(report.binding,null);
  assert(report.reasons.includes(reason));
});
test('retained bodies are bound to endpoint, capture time and digest before any interpretation',async t => {
  const directory = await mkdtemp(join(tmpdir(),'dl30-sources-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const data = sample(), sources = {};
  for (const [key,url] of Object.entries(endpoints)) {
    const body = key === 'calendar' ? data[key] : JSON.stringify(data[key]);
    sources[key] = {url,httpStatus:200,fetchedAt:now,sha256:createHash('sha256').update(body).digest('hex')};
    await writeFile(join(directory,key),body);
  }
  sources.editions.page = data.page;
  const save = () => writeFile(join(directory,'sources.json'),JSON.stringify({format:'dl30-swiss-source-capture-v1',sources}));
  await save();
  assert.deepEqual((await readStageSources(directory,now)).bodies,data);
  await assert.rejects(readStageSources(directory,'2026-11-22T11:59:59.999Z'),/invalid_source/);
  sources.valve.url = endpoints.opendota;
  await save();
  await assert.rejects(readStageSources(directory,now),/invalid_source_valve/);
  sources.valve.url = endpoints.valve;
  await save();
  await writeFile(join(directory,'calendar'),'modified');
  await assert.rejects(readStageSources(directory,now),/invalid_source_calendar/);
});
test('inclusive registration deadline and earliest possible start',() => {
  for (const [time,reason] of [[proposal.window.decisionDeadline,'DECISION_DEADLINE_PASSED'],['2026-12-01T10:00:00.000Z','START_BOUND_REACHED']]){
    const report = reviewStage(sample(),proposal,time);
    assert.equal(report.binding,null);
    assert(report.reasons.includes(reason));
  }
});
