/** Exports verified local evidence for the retrospective comparison. No imports. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createDatabase, V1DataRepository, sql, prepareV1PerMapFeatureHistory} from '../../packages/db/dist/index.js';
import {readAccountEvidence} from '../../packages/db/dist/identity-repository.js';
import {bindHeroHistory} from './post-draft-player-hero-audit.mjs';

const [directory, ...extra] = process.argv.slice(2);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let db;
try {
  assert(/^\.tools\/blast-ix-h2-diagnostic-[a-z0-9-]+$/.test(directory ?? '') && !extra.length, 'output_scope');
  const dbUrl = new URL(process.env.DATABASE_URL);
  assert(['localhost', '127.0.0.1'].includes(dbUrl.hostname), 'local_database_required');
  const cohortBytes = await readFile(join(directory, 'cohort.json'));
  const cohort = JSON.parse(cohortBytes);
  assert.equal(cohort.leagueId, '20208');
  const targetIds = new Set(cohort.rows.map(row => row.match_id));
  const toAt = new Date(Math.max(...cohort.rows.map(row => row.start_time)) * 1000).toISOString();
  const snapshotAt = new Date().toISOString();
  const filenames = ['tools/research/prepare-blast-ix-h2-history.mjs', 'tools/research/post-draft-player-hero-audit.mjs',
    'packages/db/dist/v1-data-repository.js', 'packages/db/dist/v1-features.js', 'packages/db/migrations/018_outcome_verifier.sql'];
  const code = await Promise.all(filenames.map(async path => ({path, sha256: sha(await readFile(path))})));
  db = createDatabase(dbUrl.href);
  const result = await new V1DataRepository(db).export({schemaVersion: 1, profile: 'pre-match-player-elo-data-v1', purpose: 'development_only',
    fromAt: '2024-01-01T00:00:00.000Z', toAt, snapshotAt, maxMaps: 5000}, code);
  const history = prepareV1PerMapFeatureHistory(result.source);
  const receipts = history.maps.map(map => map.outcomeReceiptId);
  const {rows: heroes} = await sql`SELECT m.id::text AS "matchId",m.data_revision::text AS "dataRevision",
      (SELECT jsonb_agg(jsonb_build_object('player_slot',p.player_slot,'hero_id',p.hero_id,'player_id',p.player_id::text))
       FROM match_players p WHERE p.match_id=m.id) AS players,
      r.id::text AS "receiptId",r.payload_sha256 AS "sourceSha256",
      (SELECT jsonb_agg(jsonb_build_object('player_slot',p->'player_slot','hero_id',p->'hero_id','account_id',p->'account_id'))
       FROM jsonb_array_elements(r.source_payload->'players') p) AS "receiptPlayers"
    FROM provider_ingest_receipts r JOIN matches m ON m.id=r.canonical_match_id WHERE r.id=ANY(${receipts}::bigint[])`.execute(db);
  const bound = bindHeroHistory(history, result.source, heroes.map(row => ({...row, players: row.players ?? []})), []);
  const boundById = new Map(bound.maps.map(map => [map.matchId, map]));
  history.maps = history.maps.filter(map => !targetIds.has(map.matchId)).map(map => {
    const match = /^opendota:([1-9]\d*)$/.exec(map.seriesKey);
    assert(match, 'unknown_history_series_namespace');
    return {...map, seriesKey: JSON.stringify(['opendota', match[1]])};
  });
  const heroHistory = {
    format: 'verified-player-hero-history-v1', syntheticOnly: false, sourceSha256: history.sourceFingerprint,
    fromAtUs: history.warmupFromAtUs, toAtUs: history.snapshotAtUs, snapshotAtUs: history.snapshotAtUs,
    maps: history.maps.map(map => ({matchId: map.matchId, startedAtUs: map.startedAtUs, completedAtUs: map.completedAtUs,
      fetchedAtUs: map.fetchedAtUs, knownAtUs: null, isPro: true, receiptSha256: map.payloadSha256, canonicalPatchId: null,
      players: [...map.teamA,...map.teamB].map(member => ({...member, heroId: boundById.get(map.matchId)?.players
        .find(p => p.playerId === member.playerId && p.accountId === member.accountId)?.heroId ?? null}))}))
  };
  // Current exact numeric links are used only for a conditional reconstruction.
  const {collected} = JSON.parse(await readFile(join(directory, 'details.json')));
  const accounts = [...new Set(collected.flatMap(map => map.players.map(p => p.accountId).filter(Boolean)))];
  const identities = (await readAccountEvidence(db, accounts)).filter(row => row.fetchedAt <= snapshotAt);
  const bytes = JSON.stringify({cohortSha256: sha(cohortBytes), snapshotAt, history, heroHistory, identities, code}) + '\n';
  await writeFile(join(directory, 'history.json'), bytes, {flag: 'wx'});
  console.log(JSON.stringify({historyMaps: history.maps.length, heroBoundMaps: history.maps.filter(m => boundById.has(m.matchId)).length,
    historySha256: sha(bytes)}));
} catch (error) {
  console.error(JSON.stringify({status: 'blocked', code: error.code ?? 'history_evidence_validation', reason: error.message.split('\n')[0]}));
  process.exitCode = 1;
} finally { await db?.destroy(); }
