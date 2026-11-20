// Only public map/series identity, start times and league metadata are requested.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';

const rawPath = '.tools/s304-historical-window-metadata-r1.json';
const reportPath = 'docs/evidence/s3-04-historical-window-screen.json';
const after = '2026-11-04T20:07:52.000Z'; // Latest historical map of the development set.
const until = '2026-11-20T00:00:00.000Z';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const query = `SELECT m.match_id::text AS map, m.series_id::text AS series, m.leagueid::text AS league,
  m.start_time, l.name, l.tier FROM matches m LEFT JOIN leagues l ON l.leagueid=m.leagueid
  WHERE m.leagueid>0 AND m.start_time>${Date.parse(after)/1000} AND m.start_time<${Date.parse(until)/1000}
  ORDER BY m.start_time,m.match_id LIMIT 10001`;

const [mode, ...extra] = process.argv.slice(2);
assert(['capture','screen','verify','postfit'].includes(mode) && !extra.length);
if (mode === 'capture') {
  const url = new URL('https://api.opendota.com/api/explorer');
  url.searchParams.set('sql', query);
  const response = await fetch(url,{redirect:'error', signal:AbortSignal.timeout(45000)});
  assert.equal(response.status,200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const body = JSON.parse(bytes);
  assert.equal(body.err,null);
  assert(Array.isArray(body.rows) && body.rows.length < 10001);
  assert(body.rows.every(row => Object.keys(row).sort().join() === 'league,map,name,series,start_time,tier'));
  const capture = {query,fetchedAt:new Date().toISOString(),payloadSha256:sha(bytes),rows:body.rows};
  await writeFile(rawPath,JSON.stringify(capture)+'\n',{flag:'wx'});
  console.log(capture.fetchedAt, body.rows.length, capture.payloadSha256);
} else {
  const bytes = await readFile(rawPath);
  const capture = JSON.parse(bytes);
  assert.equal(capture.query,query);
  assert(capture.rows.length < 10001);
  const floor = await readFile('.tools/s304-dl30-exposure-ids-r2.json');
  assert.equal(sha(floor),'d59ce0535a1a522b7ba517d62bd85a6fa7059b6d6a465359892718ba7c46b8d7');
  const ids = JSON.parse(floor), maps = new Set(ids.mapIds), keys = new Set(ids.canonicalSeriesKeys);
  const seen = new Set(), leagues = new Map(), series = new Map();
  const fit = JSON.parse(await readFile('docs/evidence/s3-04-player-hero-experiment-fit.json','utf8'));
  const fitCheckedAt = fit.readiness.checkedAt;
  assert.equal(fitCheckedAt,'2026-11-13T18:56:31.548Z');
  const postfit = new Map();
  for (const row of capture.rows) {
    assert.deepEqual(Object.keys(row).sort(), ['league','map','name','series','start_time','tier']);
    for (const id of [row.map,row.league]) assert.match(id,/^[1-9]\d*$/u);
    assert(!seen.has(row.map));
    seen.add(row.map);
    const start = new Date(row.start_time*1000).toISOString();
    assert(start>after && start<until);
    const league = leagues.get(row.league) ?? {id:row.league,name:row.name,providerTier:row.tier,
      firstObserved:start,lastObserved:start,maps:0,mapsWithoutSeries:0,knownOverlappingSeries:0,
      mapsInKnownOverlappingSeries:0,seriesWithoutKnownOverlap:0,mapsInSeriesWithoutKnownOverlap:0};
    leagues.set(row.league,league);
    league.maps++;
    league.lastObserved=start;
    if (!row.series || row.series==='0') { league.mapsWithoutSeries++; continue; }
    assert.match(row.series,/^[1-9]\d*$/u);
    const group=series.get(row.series) ?? {league:row.league,maps:[],firstObserved:start};
    if (start < group.firstObserved) group.firstObserved = start;
    assert.equal(group.league,row.league);
    group.maps.push(row.map);
    series.set(row.series,group);
  }
  for (const [id,group] of series) {
    const league=leagues.get(group.league);
    if (keys.has(JSON.stringify(['opendota',id])) || group.maps.some(map=>maps.has(map))) {
      league.knownOverlappingSeries++;
      league.mapsInKnownOverlappingSeries+=group.maps.length;
    } else {
      league.seriesWithoutKnownOverlap++;
      league.mapsInSeriesWithoutKnownOverlap+=group.maps.length;
      if (group.firstObserved > fitCheckedAt) {
        const counts = postfit.get(group.league) ?? {league:group.league,name:league.name,series:0,maps:0};
        counts.series++;
        counts.maps+=group.maps.length;
        postfit.set(group.league,counts);
      }
    }
  }
  const report={format:'h2-historical-window-screen-v1',afterExclusive:after,untilExclusive:until,
    source:{provider:'opendota',query,fetchedAt:capture.fetchedAt,payloadSha256:capture.payloadSha256,
      path:rawPath,fileSha256:sha(bytes)},exclusionsSha256:sha(floor),maps:seen.size,
    leagues:[...leagues.values()].sort((a,b)=>Number(a.id)-Number(b.id)),labelsRequested:false,
    completeEditionMembershipVerified:false,independenceEstablished:false,scoringPerformed:false};
  const result=JSON.stringify(report,null,2)+'\n';
  if(mode==='screen') await writeFile(reportPath,result,{flag:'wx'});
  assert.equal(await readFile(reportPath,'utf8'),result);
  console.log(report.maps, report.leagues.length, sha(result));
  if (mode === 'postfit') console.log(JSON.stringify({fitCheckedAt,seriesWithoutKnownIdOverlap:[...postfit.values()]},null,2));
}
