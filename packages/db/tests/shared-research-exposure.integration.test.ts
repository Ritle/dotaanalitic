import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {combineDraftInventories} from '../../../tools/research/reconcile-dl30-pc-inventories.mjs';
import {combineSeriesExposure,screenPriorSeries} from '../../../tools/research/review-series-exposure.mjs';
import {exposureSnapshot,sharedExposure} from '../../../tools/research/shared-exposure.mjs';
import {sha} from '../../../tools/research/exposure-ledger-core.mjs';
import {sql} from '../dist/index.js';

const empty = {mapIds:[],openDotaSeriesIds:[],pandaScoreMeetingIds:[]};
const inputs = {fixture:sha('synthetic local input')};
const big = '9007199254740993';
let database: Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async () => { database=await testDatabase(); },60000);
afterEach(async () => { await database?.close(); },30000);

it('both research commands share exclusions and preserve the evidence of each producer across concurrent retries',async () => {
  const local={mapIds:[big],seriesKeys:['["opendota","41"]']};
  const writeSeries=()=>combineSeriesExposure(local,inputs,database.url);
  const [one,two]=await Promise.all([writeSeries(),writeSeries()]);
  expect(one.revisions).toEqual(two.revisions);
  expect(one.revisions).toHaveLength(1);
  const draftBase={mapIds:['17'],openDotaSeriesIds:[],pandaScoreMeetingIds:['41']};
  const draft=await combineDraftInventories(draftBase,{},inputs,{connectionString:database.url,publish:true});
  expect(draft.inventory).toEqual({mapIds:['17',big],openDotaSeriesIds:['41'],pandaScoreMeetingIds:['41']});
  const series=await writeSeries();
  expect(series.revisions).toEqual(draft.registryRevisions);
  expect(series.revisions).toHaveLength(2);
  expect(screenPriorSeries([{league:'8',type:'1',id:'43',maps:['17','18']}],series.known)[0].excluded)
    .toMatchObject([{matchedMaps:['17'],matchedSeries:false}]);
  const read=await combineDraftInventories(empty,{},inputs,{connectionString:database.url});
  expect(read.registryRevisions).toEqual(series.revisions);
  const standalone=await combineDraftInventories(draftBase,{},inputs);
  expect(standalone.inventory).toEqual(draftBase);
  expect(standalone.registryRevisions).toBeUndefined();
});

it('keeps invalid, rolled-back and overwritten projections outside the common list',async () => {
  await expect(sharedExposure('postgresql:///')).rejects.toThrow('invalid_RESEARCH_DATABASE_URL');
  const raw=await exposureSnapshot('draft-lab-review',inputs,{...empty,mapIds:['23']});
  const insert=(body:string)=>sql`INSERT INTO research_exposure_snapshots(sha256,snapshot_text) VALUES(${sha(body)},${body})`;
  await expect(insert(raw.replace('"23"','"9223372036854775808"')).execute(database.db)).rejects.toThrow();
  await expect(database.db.transaction().execute(async tx=>{
    await insert(raw).execute(tx);
    expect((await sharedExposure(database.url)).revisions).toEqual([]);
    throw Error('fixture rollback');
  })).rejects.toThrow('fixture rollback');
  expect((await sharedExposure(database.url)).revisions).toEqual([]);
  await insert(raw).execute(database.db);
  await expect(sql`TRUNCATE research_exposure_snapshots`.execute(database.db)).rejects.toThrow('Immutable');
  await expect(sql`DELETE FROM research_exposure_snapshots`.execute(database.db)).rejects.toThrow('Immutable');
  expect((await sharedExposure(database.url)).inventory.mapIds).toEqual(['23']);
});

it('the normal series CLI publishes local observations and includes remote IDs in its report',async () => {
  const dir=await mkdtemp(join(tmpdir(),'research-exposure-'));
  try {
    await combineDraftInventories({...empty,mapIds:[big]}, {}, inputs,{connectionString:database.url,publish:true});
    await sql`INSERT INTO matches(id,started_at) VALUES(9223372036854775806,now())`.execute(database.db);
    const root=fileURLToPath(new URL('../../../',import.meta.url));
    const run=async(name:string)=>{
      const path=join(dir,name);
      await promisify(execFile)(process.execPath,['tools/research/review-series-exposure.mjs',path,'--shared'],
        {cwd:root,env:{...process.env,DATABASE_URL:database.url,RESEARCH_DATABASE_URL:database.url}});
      return JSON.parse(await readFile(path,'utf8'));
    };
    const first=await run('one.json'),again=await run('two.json');
    expect(again.sharedRegistry).toEqual(first.sharedRegistry);
    expect(again.sharedRegistry.revisions).toHaveLength(2);
    expect(again.registrationAllowed).toBe(false);
    expect(again.mapIds).toContain(big);
    const draftArgs=['tools/research/reconcile-dl30-pc-inventories.mjs','check-series','-','-','9223372036854775806'];
    const {stdout}=await promisify(execFile)(process.execPath,draftArgs,
      {cwd:root,env:{...process.env,RESEARCH_DATABASE_URL:database.url}});
    expect(JSON.parse(stdout)).toMatchObject({status:'known_overlap',revisions:first.sharedRegistry.revisions,
      matches:{mapIds:['9223372036854775806'],openDotaSeriesIds:[],pandaScoreMeetingIds:[]},registrationAllowed:false});
  } finally { await rm(dir,{recursive:true,force:true}); }
},60000);
