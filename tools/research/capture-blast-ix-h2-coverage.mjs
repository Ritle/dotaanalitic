/** Read-only discovery for gaps in the frozen BLAST diagnostic. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createDatabase} from '../../packages/db/dist/index.js';
import {OpenDotaClient, OpenDotaError, OpenDotaPlayerHistoryClient, PostgresProviderBudget,
  parseSource, validatePlayerHistoryMap} from '../../packages/ingestion/dist/index.js';

const base = '.tools/blast-ix-h2-diagnostic-20261122-r2';
const directory = '.tools/blast-ix-h2-coverage-r1';
const read = async name => JSON.parse(await readFile(join(base, name), 'utf8'));
const save = (name, data) => writeFile(join(directory, name), JSON.stringify(data) + '\n', {flag:'wx'});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const positive = value => /^[1-9]\d{0,18}$/.test(String(value)) && (!Number.isInteger(value) || Number.isSafeInteger(value));

async function valve() {
  const {rows} = await read('features.json');
  const requested = new Set(rows.filter(row => !row.seriesKey).map(row => row.id));
  assert.equal(requested.size, 5);
  const url = 'https://www.dota2.com/webapi/IDOTA2League/GetLeagueData/v001?league_id=20208&delay_seconds=0';
  const response = await fetch(url, {redirect:'error', signal:AbortSignal.timeout(25000)});
  assert.equal(response.status, 200, 'valve_http');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length <= 16000000, 'valve_response_limit');
  const body = JSON.parse(bytes);
  assert.equal(String(body.info?.league_id), '20208');
  assert(Array.isArray(body.series_infos));
  const series = body.series_infos.filter(row => positive(row.series_id) && Array.isArray(row.match_ids))
    .map(row => ({seriesId: String(row.series_id), type: row.series_type ?? null, maps: row.match_ids.filter(positive).map(String)}));
  const nodes = [];
  function visit(value) {
    if (value === null || typeof value !== 'object') return;
    if (Object.hasOwn(value,'node_id') && Array.isArray(value.matches)) {
      const maps = value.matches.map(row => row.match_id).filter(positive).map(String);
      if (maps.length) nodes.push({nodeId:String(value.node_id), seriesId:positive(value.series_id) ? String(value.series_id) : null,
        completed:value.is_completed === true, teams: [value.team_id_1,value.team_id_2].filter(positive).map(String), maps});
    }
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') visit(child);
  }
  visit(body.node_groups);
  const hits = [...requested].map(id => ({id, series:series.filter(row => row.maps.includes(id)), nodes:nodes.filter(row => row.maps.includes(id))}));
  await save('valve.json',{url, fetchedAt:new Date().toISOString(), sha256:sha(bytes), series, nodes, hits});
  console.log(JSON.stringify({series:series.length,nodes:nodes.length,hits}));
}

async function history() {
  const {rows} = await read('features.json');
  const {collected} = await read('details.json');
  const prior = await read('history.json');
  const targetById = new Map(collected.map(map => [map.id,map]));
  const accounts = [...new Set(rows.flatMap(row => row.historyShortages ?? []).map(item => item.accountId))];
  assert.equal(accounts.length, 2);
  const earliest = Math.min(...rows.filter(row => row.historyShortages?.length).map(row => targetById.get(row.id).startTime));
  const cutoff = new Date(earliest * 1000).toISOString();
  const known = new Set([...prior.history.maps.map(map => map.matchId), ...targetById.keys()]);
  const url = new URL(process.env.DATABASE_URL);
  assert(['127.0.0.1','localhost'].includes(url.hostname));
  const db = createDatabase(url.href);
  try {
    const limits = {rpm:Number(process.env.OPENDOTA_RPM_BUDGET ?? 45), daily:Number(process.env.OPENDOTA_DAILY_BUDGET ?? 2000),
      monthly:Number(process.env.OPENDOTA_MONTHLY_BUDGET ?? 45000)};
    const shared = new PostgresProviderBudget(db, limits);
    let requests = 0;
    const provider = new OpenDotaPlayerHistoryClient({beforeRequest:async () => {
      assert.equal(requests, 0, 'single_discovery_request');
      await shared.beforeRequest();
      requests++;
    },observe:(...args) => shared.observe(...args)}, {timeoutMs:20000});
    const options = {windowDays:730,maxMaps:10};
    const observed = await provider.discover(accounts, cutoff, options, {limit:10,cursors:{}});
    const fresh = observed.data.rows.filter(row => !known.has(row.match_id));
    await save('discovery.json',{source:observed.source, cutoff, accounts, options, rows:observed.data.rows, fresh});
    console.log(JSON.stringify({cutoff, requests, rows:observed.data.rows.length, fresh}));
  } finally { await db.destroy(); }
}

async function details() {
  const discoveryBytes = await readFile(join(directory,'discovery.json'));
  const discovery = JSON.parse(discoveryBytes);
  const ids = [...new Set(discovery.fresh.map(row => row.match_id))];
  assert(ids.length > 0 && ids.length <= 20 && ids.every(positive), 'detail_scope');
  const url = new URL(process.env.DATABASE_URL);
  assert(['127.0.0.1','localhost'].includes(url.hostname));
  const db = createDatabase(url.href);
  try {
    const limits = {rpm:Number(process.env.OPENDOTA_RPM_BUDGET ?? 45), daily:Number(process.env.OPENDOTA_DAILY_BUDGET ?? 2000),
      monthly:Number(process.env.OPENDOTA_MONTHLY_BUDGET ?? 45000)};
    const provider = new OpenDotaClient({attempts:1, maxRequests:ids.length+2, requestsPerMinute:Math.min(30,limits.rpm),
      timeoutMs:18000, maxWaitMs:0}, {budget:new PostgresProviderBudget(db,limits)});
    const retainRef = observation => ({data:observation.data,source:observation.source});
    const leagues = retainRef(await provider.getLeagues()), heroes = retainRef(await provider.getHeroes());
    const eligible = [], excluded = [];
    for (const [index,id] of ids.entries()) {
      try {
        const observation = await provider.getMatchSource(id);
        const players = discovery.fresh.filter(row => row.match_id === id);
        const assessment = validatePlayerHistoryMap({matchId:id,players},observation,leagues.data,discovery.cutoff);
        const {projection,match} = parseSource(observation,id);
        const reasons = [...assessment.reasons];
        if (!match?.series_id || !match.radiant_team_id || !match.dire_team_id || match.radiant_team_id === match.dire_team_id) reasons.push('SERIES_OR_TEAMS_UNVERIFIED');
        const slots = (match?.players ?? []).map(p=>p.player_slot).sort((a,b)=>a-b);
        if (slots.join(',') !== '0,1,2,3,4,128,129,130,131,132') reasons.push('INCOMPLETE_SLOTS');
        if (reasons.length) excluded.push({id,reasons});
        else {
          // Drop incidental player stats. This replay keeps the original source digest separately.
          projection.players = projection.players.map(({player_slot,account_id,hero_id})=>({player_slot,account_id,hero_id}));
          delete projection.picks_bans;
          const rawBody = JSON.stringify(projection);
          eligible.push({id,source:observation.source,projection,payloadSha256:sha(rawBody),seriesId:match.series_id});
        }
      } catch (error) {
        const code = error instanceof OpenDotaError ? error.code : 'LOCAL_VALIDATION_ERROR';
        excluded.push({id,reasons:[code]});
        if (['source_http_error','source_rate_limited','request_budget_exhausted'].includes(code)) {
          excluded.push(...ids.slice(index+1).map(id=>({id,reasons:['STOPPED_AFTER_PROVIDER_ERROR']})));
          break;
        }
      }
    }
    await save('prior-details.json',{discoverySha256:sha(discoveryBytes), leagues, heroes, eligible, excluded, requests:provider.requestsUsed});
    console.log(JSON.stringify({requests:provider.requestsUsed,eligible:eligible.length,excluded}));
  } finally { await db.destroy(); }
}

try {
  const [mode, ...extra] = process.argv.slice(2);
  assert(!extra.length && ['valve','history','details'].includes(mode));
  await mkdir(directory, {recursive:true});
  await {valve,history,details}[mode]();
} catch (error) {
  console.error(JSON.stringify({status:'blocked', reason:error.code ?? error.message.split('\n')[0]}));
  process.exitCode = 1;
}
