// Outcome-free metadata for the fixed historical S3-09 scope.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const [source, edition] = process.argv.slice(2);
assert(['valve', 'opendota'].includes(source) && ['17891', '18058', '18358'].includes(edition));
const url = new URL(source === 'valve' ? 'https://www.dota2.com/webapi/IDOTA2League/GetLeagueData/v001' :
  'https://api.opendota.com/api/explorer');
if (source === 'valve') url.search = new URLSearchParams({league_id:edition, delay_seconds:'0'});
else url.searchParams.set('sql', `WITH first_maps AS (
  SELECT DISTINCT ON (series_id) series_id, match_id, start_time FROM matches
  WHERE leagueid=${edition} AND series_type=1 AND series_id>0 ORDER BY series_id,start_time,match_id
) SELECT f.series_id::text, f.match_id::text, f.start_time, p.player_slot, p.account_id::text
  FROM first_maps f LEFT JOIN player_matches p ON p.match_id=f.match_id
  ORDER BY f.series_id,p.player_slot LIMIT 991`);

const response = await fetch(url, {redirect:'error', signal:AbortSignal.timeout(30000)});
assert.equal(response.status, 200, 'source HTTP status ' + response.status);
const bytes = Buffer.from(await response.arrayBuffer());
assert(bytes.length < 16_000_000);
const body = JSON.parse(bytes);
const decimal = value => {
  assert(typeof value === 'string' || Number.isSafeInteger(value));
  assert.match(String(value), /^[1-9]\d*$/);
  return String(value);
};
let rows;
if (source === 'valve') {
  assert.equal(decimal(body.info.league_id), edition);
  assert(Array.isArray(body.series_infos) && body.series_infos.length > 0);
  rows = body.series_infos.map(row => ({
    seriesId:decimal(row.series_id), type:row.series_type, maps:row.match_ids.map(decimal)
  }));
} else {
  assert.equal(body.err, null);
  assert(body.rows.length > 0 && body.rows.length < 991);
  rows = body.rows.map(row => {
    assert.equal(Object.keys(row).sort().join(','), 'account_id,match_id,player_slot,series_id,start_time');
    return {seriesId:decimal(row.series_id), map:decimal(row.match_id), start:row.start_time,
      slot:row.player_slot, account:row.account_id};
  });
}
const capture = {source, edition, url:url.href, fetchedAt:new Date().toISOString(),
  payloadSha256:createHash('sha256').update(bytes).digest('hex'), rows};
await writeFile(`.tools/s309-wallachia-${source}-${edition}.json`, JSON.stringify(capture)+'\n', {flag:'wx'});
console.log(source, edition, rows.length, capture.fetchedAt);
