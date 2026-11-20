import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {prepareReleaseHistory,resolveIdentity,canonicalContextJson} from '../../packages/db/dist/index.js';
import {createV1FeatureBuilder} from '../../packages/prediction/dist/v1-features.js';
import {publicInputs,sha} from './wallachia-prior-replay-inputs.mjs';

const read=async path=>JSON.parse(await readFile(path));
const [repeat,...extra]=process.argv.slice(2);
const extended=['extended','profiles'].includes(repeat);
assert(!extra.length && (repeat===undefined || extended || /^r[1-9]\d*$/.test(repeat)));
const screen=await read('docs/evidence/s3-09-wallachia-bo3-input-screen.json');
const original=await read('.tools/s309-wallachia-replayed-import.json');
const imported=extended?await read('.tools/s309-wallachia-replayed-import-'+repeat+'.json'):original;
const {archive}=await publicInputs();
const registersFile=await readFile('docs/evidence/s3-09-wallachia-series-registers.json.gz');
assert.equal(sha(registersFile),'9a438091827ef04003face2cc5d4fa0119998b410bf10ea6dc6ec8ae8515c0d0');
const captures=JSON.parse(gunzipSync(registersFile));
function captureAt(path) {
  const item=captures.find(r=>r.path===path);
  assert.equal(sha(item.content),item.sha256);
  return JSON.parse(item.content);
}
const graph=captureAt('.tools/s309-wallachia-series-graph.json');
const registers=captureAt('.tools/s309-wallachia-edition-registers.json');
const allTargetMaps=new Set(graph.snapshots.flatMap(s=>s.series.flatMap(n=>n.match_ids.map(String))));
for (const m of graph.opendota.rows) allTargetMaps.add(m.match_id);
const editions=graph.snapshots.map((s,i)=>{
  assert.equal(s.edition,['17891','18058','18358'][i]);
  const p=registers[i];
  assert.equal(p.edition,['9121','9264','9362'][i]);
  const nodes=s.graph.filter(n=>n.type===2 && n.started && n.completed);
  const bo3=p.rows.filter(r=>r.format===3 && r.status==='finished' && r.forfeit===false);
  assert.equal(new Set(nodes.map(n=>n.nodeId)).size,nodes.length);
  assert.equal(nodes.length,bo3.length);
  const linked=new Set(nodes.map(n=>n.seriesId));
  const orphans=s.series.filter(n=>n.series_type===1 && !linked.has(String(n.series_id))).map(raw=>({
    seriesId:String(raw.series_id),mapIds:raw.match_ids,
    sameDayNodes:nodes.filter(n=>n.teams.includes(raw.team_id_1)&&n.teams.includes(raw.team_id_2)&&
      new Date(n.actualTime*1000).toISOString().slice(0,10)===new Date(raw.start_time*1000).toISOString().slice(0,10))
      .map(n=>n.seriesId)}));
  return {edition:s.edition,pandaScoreEdition:p.edition,valveNodes:nodes.length,pandaScoreFinished:bo3.length,orphans};
});

async function coverage(ref) {
  const bytes=await readFile(ref.path);
  assert.equal(sha(bytes),ref.sha256);
  const {history}=prepareReleaseHistory(JSON.parse(bytes));
  assert(!history.syntheticOnly);
  assert(history.maps.every(m=>!allTargetMaps.has(m.matchId)),'holdout_map_in_history');
  const result=[];
  for (const edition of screen.editions) {
    const capture=JSON.parse(archive.find(x=>x.path===`.tools/s309-wallachia-opendota-${edition.edition}.json`).content);
    const held=new Set(editions.find(s=>s.edition===edition.edition).orphans.flatMap(n=>n.sameDayNodes));
    const selectedAtUs=String(BigInt(Date.parse(capture.fetchedAt))*1000n);
    for (const row of edition.rows.filter(r=>!r.overlap && !r.issues.length && r.observedFirstMap)) {
      const roster=capture.rows.filter(p=>p.seriesId===row.seriesId && p.map===row.observedFirstMap).sort((a,b)=>a.slot-b.slot);
      assert(roster.length===10 && roster.every(p=>p.start===roster[0].start));
      const players=roster.map(p=>({accountId:p.account,playerId:resolveIdentity(history.identities,p.account,null).playerId}));
      const item={seriesId:row.seriesId,edition:edition.edition,membershipHeld:held.has(row.seriesId)};
      if (!players.every(p=>p.playerId) || new Set(players.map(p=>p.playerId)).size!==10) {
        result.push({...item,status:'unavailable',reasons:['TEN_VERIFIED_IDENTITIES_REQUIRED'],
          unboundAccounts:players.filter(p=>!p.playerId).map(p=>p.accountId)});
        continue;
      }
      const cutoff=BigInt(roster[0].start)*1000000n;
      const maps=history.maps.filter(m=>BigInt(m.startedAtUs)<cutoff && BigInt(m.completedAtUs)<cutoff);
      const body={...history,maps};
      delete body.sourceFingerprint;
      // Side order only establishes the two fives for availability. No winner or series probability is calculated.
      const features=createV1FeatureBuilder({...body,sourceFingerprint:sha(canonicalContextJson(body))})({
        schemaVersion:1,cutoffAtUs:String(cutoff),targetMatchId:row.observedFirstMap,
        teamA:players.slice(0,5),teamB:players.slice(5),
        lineup:{basis:'actual_lineup_reconstructed',source:'opendota_first_observed_map',selectedAtUs,revision:capture.payloadSha256}});
      result.push({...item,status:features.status,reasons:features.reasons,minimumMaps:features.coverage.minimumPlayerMaps,
        ...(repeat && features.features ? {eloDigest:sha(canonicalContextJson(features.features))} : {}),
        shortHistory:[...features.teamA,...features.teamB].filter(p=>p.maps<5).map(p=>({account:p.accountId,maps:p.maps})),
        featureSha256:features.fingerprint});
    }
  }
  return result;
}
const baseInventory=repeat==='profiles'?(await read('.tools/s309-wallachia-replayed-import-extended.json')).inventory:
  extended?original.inventory:screen.sources.find(s=>s.path==='.tools/s309-wallachia-local-inventory-r1.json');
const baseline=await coverage(baseInventory);
const replay=await coverage(imported.inventory);
assert.equal(baseline.length,replay.length);
const summary=editions.map(edition=>{
  const counts=rows=>{
    const subset=rows.filter(r=>r.edition===edition.edition && !r.membershipHeld);
    return {compared:subset.length,ready:subset.filter(r=>r.status==='ready').length};
  };
  return {...edition,before:counts(baseline),after:counts(replay)};
});
if (repeat && !extended) {
  const second=await read('.tools/s309-wallachia-replayed-import-'+repeat+'.json');
  assert.deepEqual(second.fetchedMapHashes,imported.fetchedMapHashes);
  assert.deepEqual(second.newEligible,imported.newEligible);
  const stable=rows=>rows.map(({featureSha256,...inputs})=>inputs);
  const firstRows=stable(replay);
  assert.deepEqual(stable(await coverage(second.inventory)),firstRows);
  console.log(JSON.stringify({format:'wallachia-elo-repeated-import-v1',inventories:[imported.inventory,second.inventory],
    eligiblePriorMaps:second.newEligible.length,checkedSeries:firstRows.filter(r=>!r.membershipHeld).length,
    readySeries:firstRows.filter(r=>!r.membershipHeld && r.status==='ready').length,
    identicalInputsSha256:sha(canonicalContextJson(firstRows)),targetSeriesScored:0},null,2));
} else console.log(JSON.stringify({format:'wallachia-isolated-elo-replay-v1',inventory:imported.inventory,
  ...(extended?{baselineInventory:baseInventory,scope:repeat}:{}),summary,
  import:{requested:imported.accepted.length+imported.declined.length,accepted:imported.accepted.length,
    eligible:imported.newEligible.length,unboundMaps:imported.unboundMaps.length,excluded:imported.excluded.map(a=>({matchId:a.matchId,reasons:a.reasons})),
    before:imported.before,after:imported.after,createdSeries:imported.sourceSeriesCreated},
  baseline,replay,registered:false,targetSeriesScored:0},null,2));
