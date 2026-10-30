import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OpenDotaError, OPENDOTA_ADAPTER_VERSION } from './client.js';
import { createProviderRuntime } from '@dota/ingestion';
import { ProviderIdSchema, type OpenDotaMatch } from './schemas.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));

export function describeMatch(match: OpenDotaMatch) {
  const players = match.players ?? [];
  const expected = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
  const slots = players.map(player => player.player_slot);
  const slotsValid = slots.length === 10 && new Set(slots).size === 10 && expected.every(slot => slots.includes(slot));
  const heroes = players.map(player => player.hero_id);
  const accounts = players.map(player => player.account_id);
  const picks = match.picks_bans?.filter(action => action.is_pick === true);
  return {
    matchId: match.match_id,
    eventAt: match.start_time != null && match.start_time > 0 && match.start_time <= 253402300799
      ? new Date(match.start_time * 1000).toISOString() : null,
    knownAt: null,
    outcomePresent: typeof match.radiant_win === 'boolean',
    teamsPresent: match.radiant_team_id != null && match.dire_team_id != null && match.radiant_team_id !== match.dire_team_id,
    seriesId: match.series_id ?? null,
    providerPatchId: match.patch ?? null,
    patchReleaseVerified: false,
    gameMode: match.game_mode ?? null,
    lobbyType: match.lobby_type ?? null,
    slotsValid,
    accountIds10: slotsValid && accounts.every(id => id != null) && new Set(accounts).size === 10,
    finalHeroes10: slotsValid && heroes.every(id => id != null && id > 0) && new Set(heroes).size === 10,
    // Null preserves missing vs [] in the source. Extra picks are never dropped.
    rawDraftEvents: match.picks_bans?.length ?? null,
    rawPickEvents: picks?.length ?? null,
    firstPickSide: null,
    draftOrderValid: null,
    verifiedRoles: null,
    lineupKnownBeforeStart: null,
    proClassification: 'unverified' as const
  };
}

// Fixtures preserve observed shapes, not public player identity or live statistics.
// Source rawBody remains untouched; only an explicit test projection is written.
export function fixtureSanitizer() {
  const maps = new Map<string, string>();
  const accounts = new Map<string, string>();
  const teams = new Map<string, string>();
  const series = new Map<string, string>();
  const leagues = new Map<string, string>();
  const remap = (mapping: Map<string, string>, value: unknown, base: number) => {
    const key = String(value);
    if (!mapping.has(key)) mapping.set(key, String(base + mapping.size));
    return mapping.get(key);
  };
  const allowed = new Set(['match_id','account_id','team_id','radiant_team_id','dire_team_id','leagueid','series_id',
    'start_time','last_match_time','duration','radiant_win','radiant_score','dire_score','series_type',
    'patch','game_mode','lobby_type','players','picks_bans','radiant_team','dire_team','player_slot','hero_id',
    'lane_role','is_pick','team','order','profile','games_played','wins','is_current_team_member','teamProfile','roster']);
  function sanitize(value: unknown, key = ''): unknown {
    if (value == null) return value;
    if (key === 'match_id') return remap(maps, value, 900000000001);
    if (key === 'account_id') return remap(accounts, value, 100001);
    if (['team_id','radiant_team_id','dire_team_id'].includes(key)) return remap(teams, value, 90001);
    if (key === 'series_id') return remap(series, value, 80001);
    if (key === 'leagueid') return remap(leagues, value, 70001);
    if (key === 'start_time' || key === 'last_match_time') return 1735689600;
    if (key === 'duration') return 1800;
    if (key === 'radiant_score' || key === 'games_played' || key === 'wins') return 20;
    if (key === 'dire_score') return 10;
    if (Array.isArray(value)) return value.map(item => sanitize(item));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([field]) => allowed.has(field)).map(([field, item]) => [field, sanitize(item, field)]));
    return value;
  }
  return (data: unknown) => ({
    _fixture: { synthetic: true, origin: 'sanitized_live_shape', adapterVersion: OPENDOTA_ADAPTER_VERSION,
      redacted: ['identifiers','timestamps','names','profile personal fields','statistics values'],
      purpose: 'Boundary tests only; never production statistics or training' },
    data: sanitize(data)
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    sample: { type: 'string', default: '3' },
    out: { type: 'string', default: 'reports/s0-01-provider-spike.json' },
    'match-ids': { type: 'string' }, fixtures: { type: 'string' }
  } });
  const sample = Number(values.sample);
  if (!Number.isInteger(sample) || sample < 1 || sample > 5) throw new OpenDotaError('invalid_configuration');
  const requested = values['match-ids']?.split(',');
  if (requested && (requested.length > 5 || new Set(requested).size !== requested.length)) {
    throw new OpenDotaError('invalid_configuration');
  }
  if (requested?.some(id => !ProviderIdSchema.safeParse(id).success)) throw new OpenDotaError('invalid_id');
  const runtime=createProviderRuntime(process.env,25);
  const client=runtime.client;
  try {
  const discovery = await client.getProMatches();
  const discoveredIds = new Set(discovery.data.map(match => match.match_id));
  const ids = requested ?? [...discoveredIds].slice(0, sample);
  if (!ids.length) throw new OpenDotaError('source_schema_invalid', '/proMatches');
  const errors: { code: string; endpoint: string | null; status: number | null; retryAfterMs: number | null; fields: readonly string[] }[] = [];
  const matches = [];
  const fixtures: { name: string; data: unknown }[] = [{ name: 'discovery', data: discovery.data.slice(0, 3) }];
  let teamId: string | undefined;
  let accountId: string | undefined;
  for (const id of ids) {
    try {
      const observation = await client.getMatch(id);
      matches.push({ ...describeMatch(observation.data), discoveredViaProMatches: discoveredIds.has(id), source: observation.source });
      if (fixtures.length < 3) fixtures.push({ name: `match-${fixtures.length}`, data: observation.data });
      teamId ??= observation.data.radiant_team_id ?? observation.data.dire_team_id ?? undefined;
      accountId ??= observation.data.players?.find(player => player.account_id != null)?.account_id ?? undefined;
    } catch (error) { recordError(error); }
  }
  let team = null;
  let roster = null;
  let player = null;
  if (teamId) {
    try {
      const observation = await client.getTeam(teamId);
      team = { source: observation.source, teamId: observation.data.team_id, lastMatchTime: observation.data.last_match_time ?? null };
      const members = await client.getTeamPlayers(teamId);
      roster = { source: members.source, observations: members.data.length,
        currentMemberFlags: members.data.filter(member => member.is_current_team_member === true).length,
        falseMembershipFlags: members.data.filter(member => member.is_current_team_member === false).length,
        unknownMembershipFlags: members.data.filter(member => member.is_current_team_member == null).length,
        hypotheticalLineup: null, verifiedHistoricalLineup: null };
      fixtures.push({ name: 'team-roster', data: { teamProfile: observation.data, roster: members.data } });
    } catch (error) { recordError(error); }
  }
  if (accountId) {
    try {
      const observation = await client.getPlayer(accountId);
      player = { source: observation.source, profilePresent: observation.data.profile != null,
        accountId: observation.data.profile?.account_id ?? null, proHistoryFromThisEndpoint: false };
      fixtures.push({ name: 'player', data: observation.data });
    } catch (error) { recordError(error); }
  }
  const status = errors.length || matches.length !== ids.length || !team || !roster || !player ? 'partial' : 'complete';
  const report = { schemaVersion: 1, mode: 'live_opendota', generatedAt: new Date().toISOString(), status,
    adapterVersion: OPENDOTA_ADAPTER_VERSION, requestsUsed: client.requestsUsed, requestBudget: 25,
    discovery: { source: discovery.source, count: discovery.data.length }, matches, team, roster, player, errors,
    limitations: ['Recent/explicit map sample only; not a historical stratified corpus',
      'proMatches is discovery evidence, not verified league/tier classification',
      'knownAt, pre-start lineup, first pick and patch-specific draft rules remain unknown',
      'Current membership and player profile do not prove a map lineup or pro-only history',
      'Attempt budget/rate serialization are process-local; durable global/monthly accounting belongs to S0-02',
      'No matches persisted, no model trained or activated; raw HTTP bodies are not in this report'] };
  const output = resolve(root, values.out);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  if (values.fixtures && status === 'complete') {
    const folder = resolve(root, values.fixtures);
    await mkdir(folder, { recursive: true });
    const sanitize = fixtureSanitizer();
    for (const fixture of fixtures) await writeFile(resolve(folder, `${fixture.name}.json`),
      JSON.stringify(sanitize(fixture.data), null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({ status, requestsUsed: client.requestsUsed, maps: matches.length, errors,
    report: output, fixturesWritten: values.fixtures && status === 'complete' ? fixtures.length : 0 }));
  if (status !== 'complete') process.exitCode = 1;

  function recordError(error: unknown) {
    errors.push(error instanceof OpenDotaError
      ? { code: error.code, endpoint: error.endpoint, status: error.status, retryAfterMs: error.retryAfterMs, fields: error.fields }
      : { code: 'source_network_error', endpoint: null, status: null, retryAfterMs: null, fields: [] });
  }
  } finally { await runtime.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify(error instanceof OpenDotaError
      ? { code: error.code, message: error.message, endpoint: error.endpoint, status: error.status, retryAfterMs: error.retryAfterMs, fields: error.fields }
      : { code: 'provider_spike_failed', message: 'Проверка OpenDota не выполнена.' }));
    process.exitCode = 1;
  });
}
