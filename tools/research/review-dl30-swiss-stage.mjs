import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {bindingV2Sha as sha, parseBindingEvidenceJson as parse} from './conditional-tournament-binding-v2.mjs';

export const endpoints = {
  calendar: 'https://pro.eslgaming.com/dreamleague/',
  valve: 'https://www.dota2.com/webapi/IDOTA2League/GetLeagueInfoList/v001',
  opendota: 'https://api.opendota.com/api/leagues',
  editions: 'https://api.pandascore.co/leagues/4125/series?filter%5Bseason%5D=30&per_page=100&page=1',
};
const proposalSha256 = '5d6015e97563ed366f5ec40ec3c941c3896607b29c1e0b0735431bd5be2b55f0';
const packageSha256 = '51183190a4710947b1135167fe52dc1c6eb0f30aca21d1c30a0fc97b53c6bd1f';
const normalize = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
function id(value) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return null;
  return /^[1-9]\d{0,18}$/.test(String(value)) && BigInt(value) <= 9223372036854775807n ? String(value) : null;
}
function iso(time) {
  return typeof time === 'string' && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time;
}
function providerTime(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    ? Date.parse(value) : NaN;
}
function calendarBound(html, scope) {
  const visible = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const title = normalize(visible.match(/<title\b[^>]*>([^<]*)<\/title>/i)?.[1]);
  const text = normalize(visible.replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/(?:&#8211;|&ndash;|[–—])/gi, '-'));
  if (!/^dreamleague season 30(?:\s*-\s*esl dota2 dreamleague)?$/.test(title) ||
      !text.includes('tournament dates: 2 - 13 december 2026 swiss stage dates: 2 - 7 december playoff dates: 8 - 13 december') ||
      !/\bswiss stage\s+6 swiss rounds with 24 teams\s+all series are best-of-three\b/.test(text)) return null;
  // Earliest instant of the announced local date anywhere on Earth (UTC+14).
  return new Date(Date.parse(scope.fromDate + 'T00:00:00+14:00')).toISOString();
}

function regularStages(edition) {
  if (!Array.isArray(edition.tournaments)) return null;
  const stages = [], seen = new Set();
  for (const row of edition.tournaments) {
    const key = id(row.id);
    if (!key || seen.has(key) || id(row.serie_id) !== id(edition.id) || id(row.league_id) !== '4125') return null;
    seen.add(key);
    const name = normalize(row.name);
    if (/playoff|qualif|division|tie[ -]?break/.test(name)) continue;
    const round = /^swiss(?: stage)?(?:\s*[-·:]\s*|\s+)round ([1-6])$/.exec(name);
    if (name === 'swiss stage' || name === 'swiss' || round) {
      if (/playoff|qualif|division|tie[ -]?break/i.test(row.slug ?? '')) return null;
      stages.push({id:key, round:round ? Number(round[1]) : null});
    } else if (/swiss/.test(name)) return null;
  }
  if (stages.length === 1 && stages[0].round === null) return stages;
  stages.sort((a,b) => a.round - b.round);
  return stages.length === 6 && stages.every((stage,i) => stage.round === i+1) ? stages : null;
}

export function reviewStage({calendar, valve, opendota, editions, page}, proposal, checkedAt) {
  assert(iso(checkedAt), 'invalid_check_time');
  const {scope, window} = proposal, reasons = [];
  const firstSeriesStartLowerBound = calendarBound(calendar, scope);
  if (!firstSeriesStartLowerBound) reasons.push('ESL_SWISS_CALENDAR_UNVERIFIED');
  if (checkedAt >= window.decisionDeadline) reasons.push('DECISION_DEADLINE_PASSED');
  if (firstSeriesStartLowerBound && checkedAt >= firstSeriesStartLowerBound) reasons.push('START_BOUND_REACHED');
  const isMain = row => normalize(row.name) === normalize(scope.edition);
  assert(Array.isArray(valve.infos) && Array.isArray(opendota) && Array.isArray(editions), 'invalid_catalogue');
  const native = valve.infos.filter(isMain), od = opendota.filter(isMain);
  const nativeId = native.length === 1 ? id(native[0].league_id) : null;
  if (!nativeId || scope.excludedLeagueIds.includes(nativeId) || od.length !== 1 ||
      id(od[0].leagueid) !== nativeId || !['professional','premium'].includes(od[0].tier) ||
      valve.infos.filter(row => id(row.league_id) === nativeId).length !== 1 ||
      opendota.filter(row => id(row.leagueid) === nativeId).length !== 1) reasons.push('MAIN_LEAGUE_UNVERIFIED');

  const editionIds = editions.map(row => id(row.id));
  if (page.number !== '1' || page.size !== '100' || page.total !== String(editions.length) ||
      editions.length > 100 || page.hasNext !== false || editionIds.includes(null) ||
      new Set(editionIds).size !== editionIds.length) reasons.push('EDITION_PAGE_INCOMPLETE');
  const main = editions.filter(row => id(row.league_id) === '4125' && id(row.league?.id) === '4125' &&
    normalize(row.league.name) === 'dreamleague' && normalize(row.videogame?.slug) === 'dota-2' &&
    String(row.season) === '30' && row.year === 2026 &&
    Object.hasOwn(row,'name') && (row.name === null || typeof row.name === 'string') &&
    /^(?:|main event|dreamleague season 30)$/.test(normalize(row.name)) &&
    /^dreamleague-(?:main-event-)?(?:season-)?30-2026$/.test(row.slug) &&
    !/qualif|division|playoff|tie[ -]?break/i.test([row.full_name,row.slug].join(' ')));
  const edition = main.length === 1 ? main[0] : null;
  if (!edition || !id(edition.id)) reasons.push('MAIN_EDITION_UNVERIFIED');
  const stages = edition && regularStages(edition);
  if (!stages) reasons.push('SWISS_STAGE_IDS_UNVERIFIED');
  else {
    const selectedIds = new Set(stages.map(stage => stage.id));
    if (editions.some(other => other !== edition && Array.isArray(other.tournaments) &&
        other.tournaments.some(row => selectedIds.has(id(row.id))))) reasons.push('STAGE_ID_IN_OTHER_EDITION');
  }
  if (firstSeriesStartLowerBound && edition) {
    const start = edition.begin_at, end = edition.end_at;
    // The same season also has regional events. Published main-event dates must fit ESL's opening day
    // and extend at least into the last regular round. Missing dates add no conflicting evidence.
    const latestOpening = Date.parse(scope.fromDate + 'T23:59:59.999-12:00');
    const earliestLastRound = Date.parse(scope.throughDate + 'T00:00:00+14:00');
    if ((start != null && !(providerTime(start) >= Date.parse(firstSeriesStartLowerBound) && providerTime(start) <= latestOpening)) ||
        (end != null && !(providerTime(end) >= earliestLastRound))) reasons.push('EDITION_CALENDAR_CONFLICT');
  }
  // Conflicting published times require review; later round pairings may still be unknown.
  if (firstSeriesStartLowerBound && edition && stages) {
    const end = Date.parse(scope.throughDate + 'T23:59:59.999-12:00');
    for (const row of edition.tournaments.filter(row => stages.some(stage => stage.id === id(row.id)))) {
      if ([row.begin_at,row.end_at].some(t => t != null && !(providerTime(t) >= Date.parse(firstSeriesStartLowerBound) &&
          providerTime(t) <= end)) || (row.begin_at && row.end_at && providerTime(row.begin_at) > providerTime(row.end_at))) {
        reasons.push('STAGE_CALENDAR_CONFLICT'); break;
      }
    }
  }
  return {status:reasons.length ? 'unavailable' : 'stage_evidence_ready', reasons, checkedAt,
    counts:{valveLeagues:valve.infos.length, openDotaLeagues:opendota.length, pandaScoreEditions:editions.length},
    firstSeriesStartLowerBound, startBasis:firstSeriesStartLowerBound ? 'earliest_utc_instant_of_esl_local_date' : null,
    binding:reasons.length ? null : {openDotaLeagueId:nativeId, pandaScoreEditionId:id(edition.id), stages},
    registrationPerformed:false, collectionAllowed:false, activationAllowed:false};
}

export async function readStageSources(directory, checkedAt) {
  const manifest = parse(await readFile(join(directory, 'sources.json'), 'utf8'));
  assert.equal(manifest.format, 'dl30-swiss-source-capture-v1');
  const bodies = {};
  for (const [key,url] of Object.entries(endpoints)) {
    const source = manifest.sources[key], bytes = await readFile(join(directory,key));
    assert(source.url === url && source.httpStatus === 200 && iso(source.fetchedAt) &&
      source.fetchedAt <= checkedAt && sha(bytes) === source.sha256, 'invalid_source_' + key);
    const content = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    bodies[key] = key === 'calendar' ? content : parse(content);
  }
  return {bodies:{...bodies,page:manifest.sources.editions.page},sources:manifest.sources};
}

export async function replayStage(directory, checkedAt = new Date().toISOString()) {
  const proposalBytes = await readFile('tools/research/player-hero-dl30-swiss-proposal.json');
  assert.equal(sha(proposalBytes), proposalSha256, 'proposal_changed');
  assert.equal(sha(await readFile('.tools/s304-dl30-swiss-package-r1.json')), packageSha256, 'package_changed');
  const {bodies,sources} = await readStageSources(directory,checkedAt);
  return {...reviewStage(bodies, parse(proposalBytes.toString()), checkedAt),
    proposalSha256,packageSha256,sources};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length,3,'usage: node tools/research/review-dl30-swiss-stage.mjs CAPTURE_DIRECTORY');
  console.log(JSON.stringify(await replayStage(process.argv[2]), null, 2));
}
