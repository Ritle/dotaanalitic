import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, relative, resolve, sep, win32} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const maxBytes = 32 * 1024 * 1024;
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const mapAdapter = 'opendota_match_receipt';
const pilotAdapter = 'private_pilot_issuance';
const leagueDirectory = 'bo3-eight-native-sources';
const fields = ['maps','openDota','pandaScore'];
const ids = ({maps = [], openDota = [], pandaScore = []} = {}) => ({maps,openDota,pandaScore});

function decimal(value) {
  assert(typeof value === 'string' || Number.isSafeInteger(value), 'unsafe_numeric_id');
  const text = String(value);
  assert(/^[1-9][0-9]{0,18}$/.test(text) && BigInt(text) <= 9223372036854775807n, 'invalid_provider_id');
  return text;
}

function readPayload(envelope, endpoint) {
  assert(envelope?.source?.provider === 'opendota' && envelope.source.endpoint === endpoint,
    'unsupported_opendota_envelope');
  assert(typeof envelope.rawBody === 'string' && sha(envelope.rawBody) === envelope.source.payloadSha256,
    'provider_payload_sha_mismatch');
  return JSON.parse(envelope.rawBody);
}

function seriesFrom(row) {
  return row.series_id == null || ['0',''].includes(String(row.series_id)) ? null : decimal(row.series_id);
}

export function matchIds(file, envelope) {
  const name = /^([1-9][0-9]*)\.json\.gz$/.exec(basename(file));
  assert(name, 'unsupported_match_filename');
  const raw = readPayload(envelope, '/matches/' + name[1]);
  assert.equal(decimal(raw.match_id),name[1],'match_id_mismatch');
  assert.equal(decimal(envelope.data?.match_id),name[1],'match_projection_mismatch');
  const series = seriesFrom(raw);
  const projectedSeries = seriesFrom(envelope.data);
  if (projectedSeries !== null) assert.equal(projectedSeries,series,'match_series_projection_mismatch');
  return ids({maps:[name[1]],openDota:series === null ? [] : [series]});
}

export function leagueMatchIds(file, envelope) {
  const name = /^([1-9][0-9]*)\.json\.gz$/.exec(basename(file));
  assert(name, 'unsupported_league_filename');
  const raw = readPayload(envelope, '/leagues/' + name[1] + '/matches');
  assert(Array.isArray(raw) && raw.length <= 50000,'unsupported_league_payload');
  const matches = new Map();
  for (const row of raw) {
    if (row.leagueid != null) assert.equal(decimal(row.leagueid),name[1],'league_id_mismatch');
    const map = decimal(row.match_id), series = seriesFrom(row);
    if (matches.has(map)) assert.equal(matches.get(map),series,'conflicting_league_match');
    matches.set(map,series);
  }
  return ids({maps:[...matches.keys()].sort(),openDota:[...new Set([...matches.values()].filter(Boolean))].sort()});
}

function within(directory, path) {
  const rel = relative(directory,path);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

async function bytesInProject(root, file) {
  const source = resolve(root,...file.split(/[\\/]/));
  assert(within(root,source),'source_outside_project');
  const actual = await realpath(source);
  assert(within(root,actual),'source_outside_project');
  const info = await stat(actual);
  assert(info.isFile() && info.size > 0 && info.size <= maxBytes, 'invalid_source_size');
  const bytes = await readFile(actual);
  assert(bytes.length <= maxBytes,'invalid_source_size');
  return bytes;
}

function decode(file, bytes) {
  return JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes,{maxOutputLength:maxBytes}) : bytes).toString('utf8'));
}

function checkProjection(extracted, row) {
  for (const field of fields) {
    const reported = row.outsideOffline[field].map(decimal);
    assert.equal(extracted[field].length,row.counts[field],'source_id_count_mismatch');
    assert(reported.every(id=>extracted[field].includes(id)),'reported_id_missing_from_source');
  }
}

export async function recheck(report, reportSha256, root) {
  assert.equal(report.format,'pc2-offline-id-comparison-v1','unexpected_report_format');
  const rows = report.sources.filter(row=>row.group==='privateFiles' &&
    (row.adapters.includes(mapAdapter) || row.adapters.includes(pilotAdapter)));
  const archives = report.notMappedOrNoIds.filter(path=>
    win32.basename(win32.dirname(path)) === leagueDirectory && /^\d+\.json\.gz$/.test(win32.basename(path)));
  const evidence = [
    ...rows.map(row=>({file:row.source, type:row.adapters.includes(mapAdapter) ? 'opendota-match' : 'pandascore-pilot',row})),
    ...archives.map(file=>({file,type:'opendota-league'}))
  ];
  const results = [];
  for (const {file,type,row} of evidence) {
    let fingerprint;
    try {
      const bytes = await bytesInProject(root,file);
      fingerprint = sha(bytes);
      if (row) assert(validDigest(row.sha256) && row.sha256 === fingerprint,'source_sha_mismatch');
      if (type === 'pandascore-pilot') {
        results.push({file,type,sha256:fingerprint,status:'hash_verified_only'});
        continue;
      }
      const name = win32.basename(file);
      const payload = decode(file,bytes);
      const found = type === 'opendota-match' ? matchIds(name,payload) : leagueMatchIds(name,payload);
      if (row) checkProjection(found,row);
      results.push({file,type,sha256:fingerprint,status:'ids_verified',ids:found});
    } catch (error) {
      const reason = /^[a-zA-Z0-9_]+$/.test(error.message) ? error.message : error.code ?? 'source_unrecognized';
      results.push({file,type,sha256:fingerprint ?? null,status:'unresolved',reason});
    }
  }
  return {format:'pc2-exposure-source-recheck-v1',reportSha256,checkedAt:new Date().toISOString(),
    summary:Object.fromEntries(['ids_verified','hash_verified_only','unresolved'].map(status=>
      [status,results.filter(row=>row.status===status).length])),
    unmappedOutsideScope:report.notMappedOrNoIds.length-archives.length,completeGlobalInventory:false,
    sources:results};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [reportFile,expectedDigest,output,...extra] = process.argv.slice(2);
  assert(reportFile && validDigest(expectedDigest) && output && !extra.length,
    'usage: node recheck-pc2-exposure.mjs REPORT EXPECTED_SHA256 NEW_OUTPUT');
  const root = await realpath(process.cwd());
  const bytes = await bytesInProject(root,reportFile);
  assert.equal(sha(bytes),expectedDigest,'input_report_sha_mismatch');
  const result = await recheck(JSON.parse(bytes),expectedDigest,root);
  const encoded = JSON.stringify(result,null,2)+'\n';
  await writeFile(output,encoded,{flag:'wx'});
  console.log(JSON.stringify({output,sha256:sha(encoded),...result.summary,unmappedOutsideScope:result.unmappedOutsideScope}));
}
