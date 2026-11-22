/** Explicit Valve sidecar for the same frozen OpenDota target cohort. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const sameSet = (a,b) => [...a].sort().join(':') === [...b].sort().join(':');
const positive = id => typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id);

export function bindBlastIxSeries(details, snapshot) {
  const maps = new Map(details.collected.map(row => [row.id,row]));
  const bindings = [];
  const collected = details.collected.map(row => {
    if (row.seriesId !== null) return row;
    const series = snapshot.series.filter(group=>group.maps.includes(row.id));
    const nodes = snapshot.nodes.filter(group=>group.maps.includes(row.id));
    if (series.length !== 1 || nodes.length !== 1) return row;
    const [native] = series, [node] = nodes;
    if (!positive(native.seriesId) || node.seriesId !== native.seriesId || !node.completed || native.type !== 1 ||
      ![2,3].includes(native.maps.length) || new Set(native.maps).size !== native.maps.length ||
      !sameSet(native.maps,node.maps) || node.teams.length !== 2 || new Set(node.teams).size !== 2 ||
      !sameSet(node.teams,[row.radiantTeamId,row.direTeamId])) return row;
    if (native.maps.some(id => {
      const peer = maps.get(id);
      return peer && ((peer.seriesId !== null && peer.seriesId !== native.seriesId) ||
        !sameSet(node.teams,[peer.radiantTeamId,peer.direTeamId]));
    })) return row;
    bindings.push({id:row.id,seriesId:native.seriesId,nodeId:node.nodeId,teams:node.teams,mapIds:native.maps});
    return {...row,seriesId:native.seriesId,seriesEvidence:'valve_league_series_and_bracket'};
  });
  return {collected,bindings};
}

async function main() {
  const [mode, directory, ...extra] = process.argv.slice(2);
  assert(['build','verify'].includes(mode) && /^\.tools\/blast-ix-h2-diagnostic-20261122-(valve|r3)$/.test(directory ?? '') && !extra.length);
  const base = '.tools/blast-ix-h2-diagnostic-20261122-r2';
  const read = async file => {const bytes=await readFile(file); return {bytes,data:JSON.parse(bytes),sha256:sha(bytes)};};
  const save = async (file,bytes) => {
    const path = join(directory,file);
    if (mode === 'build') await writeFile(path,bytes,{flag:'wx'});
    else assert.equal(sha(await readFile(path)),sha(bytes),'series_replay_difference');
  };
  const sha = bytes=>createHash('sha256').update(bytes).digest('hex');
  const [cohort,detail,outcome,valve] = await Promise.all([read(join(base,'cohort.json')),read(join(base,'details.json')),
    read(join(base,'outcomes.json')),read('.tools/blast-ix-h2-coverage-r1/valve.json')]);
  assert.equal(detail.data.cohortSha256,cohort.sha256);
  assert.equal(outcome.data.cohortSha256,cohort.sha256);
  assert.equal(outcome.data.detailsSha256,detail.sha256);
  assert.equal(valve.data.url,'https://www.dota2.com/webapi/IDOTA2League/GetLeagueData/v001?league_id=20208&delay_seconds=0');
  const {collected,bindings} = bindBlastIxSeries(detail.data,valve.data);
  const stringify = value=>JSON.stringify(value)+'\n';
  const details = stringify({...detail.data,collected,originalDetailsSha256:detail.sha256,valveProjectionSha256:valve.sha256});
  const labels = stringify({...outcome.data,detailsSha256:sha(details),originalOutcomesSha256:outcome.sha256});
  if(mode === 'build') await mkdir(directory);
  await save('cohort.json',cohort.bytes);
  await save('details.json',details);
  await save('outcomes.json',labels);
  await save('series-binding.json',stringify({valveProjectionSha256:valve.sha256,valveResponseSha256:valve.data.sha256,
    originalDetailsSha256:detail.sha256,detailsSha256:sha(details),bindings}));
  console.log(JSON.stringify({status:mode==='verify'?'replayed':'bound',bindings:bindings.length,stillMissing:collected.filter(m=>!m.seriesId).length}));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
