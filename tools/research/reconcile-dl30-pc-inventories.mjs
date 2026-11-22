import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {id, sha, seriesKey} from './exposure-ledger-core.mjs';
import {exposureSnapshot,fromKeys,sharedExposure} from './shared-exposure.mjs';

const packageDigest='51183190a4710947b1135167fe52dc1c6eb0f30aca21d1c30a0fc97b53c6bd1f';
const archives={
  'public-inputs':'eabf0361d8183fd9969e9b05bd950350292965dd6deb4565fbb6912dc4185e0e',
  'series-registers':'9a438091827ef04003face2cc5d4fa0119998b410bf10ea6dc6ec8ae8515c0d0',
  'extended-priors':'33f92636e328062180ce46d0ba42041bbe333aa3bcfacf63bce3920721b575e7',
};
const empty=()=>({mapIds:[],openDotaSeriesIds:[],pandaScoreMeetingIds:[]});
const sorted=values=>[...new Set(values)].sort();
const normalize=lists=>Object.fromEntries(Object.entries(lists).map(([field,ids])=>[field,sorted(ids.map(id))]));
const counts=lists=>Object.fromEntries(Object.entries(lists).map(([key,ids])=>[key,ids.length]));
async function pinned(path,digest) {
  const bytes=await readFile(path);
  assert.equal(sha(bytes),digest,'digest mismatch: '+path);
  return bytes;
}
function nativeId(value) {
  if(typeof value==='number')assert(Number.isSafeInteger(value),'unsafe ID');
  return id(typeof value==='number'?String(value):value);
}
export function inventoryFromReview(review) {
  assert.equal(review.format,'series-exposure-review-v1');
  assert(review.completeGlobalInventory===false&&review.registrationAllowed===false,'unexpected review status');
  assert.equal(new Date(review.capturedAt).toISOString(),review.capturedAt);
  const inventory=fromKeys(review.mapIds,review.seriesKeys);
  const {mapIds,openDotaSeriesIds,pandaScoreMeetingIds}=counts(inventory);
  assert.equal(mapIds,review.mapIds.length,'duplicate map');
  assert.equal(openDotaSeriesIds+pandaScoreMeetingIds,review.seriesKeys.length,'duplicate series');
  assert.deepEqual(review.summary,{maps:mapIds,openDotaSeries:openDotaSeriesIds,pandaScoreSeries:pandaScoreMeetingIds});
  return inventory;
}
function unpack(entries) {
  const files=new Map();
  for(const entry of entries) {
    assert.equal(sha(entry.content),entry.sha256,'archived content digest mismatch');
    assert(!files.has(entry.path),'duplicate archived file');
    files.set(entry.path,JSON.parse(entry.content));
  }
  return files;
}
export function wallachiaInventory(inputs,registers,extra) {
  const maps=new Set(), byMap=new Map(), valveGroups=[], panda=new Set();
  const addMap=value=>maps.add(nativeId(value));
  function addNative(map,series) {
    const key=nativeId(map),value=nativeId(series);
    assert(!byMap.has(key)||byMap.get(key)===value,'conflicting OpenDota series');
    byMap.set(key,value);maps.add(key);
  }
  for(const [path,data] of unpack(inputs)){
    if(/^\.tools\/s309-wallachia-valve-\d+\.json$/.test(path)) {
      assert.equal(data.source,'valve');
      for(const row of data.rows)valveGroups.push({series:row.seriesId,maps:row.maps});
    } else if(/^\.tools\/s309-wallachia-opendota-\d+\.json$/.test(path)) {
      assert.equal(data.source,'opendota');
      for(const row of data.rows)addNative(row.map,row.seriesId);
    } else {
      assert(/^\.tools\/s309-wallachia-prior-(?:lineups-)?\d+\.json$/.test(path),'unreviewed prior format');
      for(const row of data.rows)addMap(row.match_id);
    }
  }
  const files=unpack(registers),graph=files.get('.tools/s309-wallachia-series-graph.json');
  for(const row of graph.opendota.rows)addNative(row.match_id,row.series_id);
  for(const snap of graph.snapshots) {
    for(const row of snap.series)valveGroups.push({series:row.series_id,maps:row.match_ids});
    for(const node of snap.graph)for(const game of node.games)addMap(game.id);
  }
  // The two Valve projections may contain different subsets of one series.
  const siblingsBySeries=new Map(),valveMembership=new Map();
  for(const group of valveGroups){
    const number=nativeId(group.series),siblings=siblingsBySeries.get(number)??new Set();
    for(const value of group.maps){
      const map=nativeId(value);
      assert(!valveMembership.has(map)||valveMembership.get(map)===number,'conflicting Valve series');
      valveMembership.set(map,number);siblings.add(map);maps.add(map);
    }
    siblingsBySeries.set(number,siblings);
  }
  const unbound=new Set();
  for(const [number,siblings] of siblingsBySeries){
    const linked=[...siblings].map(map=>byMap.get(map)).filter(Boolean);
    assert(linked.every(value=>value===number),'conflicting Valve/OpenDota link');
    if(!linked.length)unbound.add(number);
    else for(const map of siblings)addNative(map,number);
  }
  for(const page of files.get('.tools/s309-wallachia-edition-registers.json')){
    assert.equal(page.rows.length,page.total,'partial archived edition');
    for(const row of page.rows){
      assert.equal(row.edition,page.edition,'different PandaScore edition');
      const meeting=nativeId(row.id);
      assert(!panda.has(meeting),'duplicate PandaScore meeting');
      panda.add(meeting);
    }
  }
  assert.equal(extra.format,'wallachia-extra-priors-v1');
  for(const receipt of extra.receipts) {
    assert.equal(sha(receipt.raw),receipt.sha256,'extra discovery digest');
    for(const row of JSON.parse(receipt.raw).rows)addMap(row.match_id);
  }
  for(const row of extra.rows)addMap(row.match_id);
  return {inventory:normalize({mapIds:[...maps],openDotaSeriesIds:[...byMap.values()],pandaScoreMeetingIds:[...panda]}),
    valveSeriesWithoutVerifiedOpenDotaLink:sorted(unbound),mapsWithoutSeriesInTheseArchives:[...maps].filter(m=>!byMap.has(m)).length};
}
function mergeInventories(base,sources) {
  const added=empty(),total=empty(),contributions={};
  for(const field of Object.keys(base)){
    const prior=new Set(base[field]),union=new Set(prior);
    for(const [name,source] of Object.entries(sources)){
      const values=new Set(source[field]);
      (contributions[name]??={})[field]={observed:values.size,outsideBase:[...values].filter(v=>!prior.has(v)).length};
      for(const value of values)union.add(value);
    }
    total[field]=sorted(union);added[field]=total[field].filter(v=>!prior.has(v));
  }
  return {inventory:total, summary:{base:counts(base),contributions,added,total:counts(total),unionSha256:sha(JSON.stringify(total))}};
}
export function reconcile(base,sources) {
  return mergeInventories(base,sources).summary;
}
export async function combineDraftInventories(base,sources,inputDigests,{connectionString,publish=false}={}) {
  const local=mergeInventories(base,sources);
  if (!connectionString) return local;
  const snapshot=publish ? await exposureSnapshot('draft-lab-review',inputDigests,local.inventory) : undefined;
  const shared=await sharedExposure(connectionString,snapshot);
  const result=mergeInventories(base,{...sources,sharedRegistry:shared.inventory});
  return {...result,registryRevisions:shared.revisions};
}
export async function readPcInventories(localPath,localSha,peerPath,peerSha,
  registry={connectionString:process.env.RESEARCH_DATABASE_URL}) {
  assert(!!localPath===!!localSha && !!peerPath===!!peerSha &&
    (localPath || (registry.connectionString && !peerPath)), 'incomplete PC review arguments');
  const base=JSON.parse(await pinned('.tools/s304-dl30-swiss-package-r1.json',packageDigest));
  const lists=fromKeys(base.exclusions.mapIds,[...base.exclusions.canonicalSeriesKeys.map(seriesKey),...base.separatePandaScoreSeriesKeys]);
  const packed={};
  for(const [key,digest] of Object.entries(archives)){
    const bytes=await pinned('docs/evidence/s3-09-wallachia-'+key+'.json.gz',digest);
    packed[key]=JSON.parse(gunzipSync(bytes,{maxOutputLength:32*1024*1024}));
  }
  const history=wallachiaInventory(packed['public-inputs'],packed['series-registers'],packed['extended-priors']);
  const sources={archivedWallachia:history.inventory},reviews={};
  async function include(name,path,digest){
    const review=JSON.parse(await pinned(path,digest));
    assert(!Object.hasOwn(review,'sharedRegistry'),'shared aggregate cannot certify a PC inventory');
    assert(Date.parse(review.capturedAt)<=Date.now(),'future review');
    sources[name]=inventoryFromReview(review);
    const {maps,openDotaSeries,pandaScoreSeries,projectionSha256}=review.database;
    assert([maps,openDotaSeries,pandaScoreSeries].every(n=>Number.isSafeInteger(n)&&n>=0),'invalid database counts');
    assert(maps<=sources[name].mapIds.length&&openDotaSeries<=sources[name].openDotaSeriesIds.length&&
      pandaScoreSeries<=sources[name].pandaScoreMeetingIds.length,'database counts exceed inventory');
    assert.match(projectionSha256,/^[a-f0-9]{64}$/);
    reviews[name]={sha256:digest,capturedAt:review.capturedAt,database:{maps,openDotaSeries,pandaScoreSeries,projectionSha256}};
  }
  if(localPath) await include('local',localPath,localSha);
  if(peerPath){
    assert.notEqual(peerSha,localSha,'same report supplied for both PCs');
    await include('peer',peerPath,peerSha);
  }
  if (registry.privateInventory) sources.private = registry.privateInventory;
  const inputDigests={base:packageDigest,...archives};
  if (localSha) inputDigests.local=localSha;
  if (peerSha) inputDigests.peer=peerSha;
  const {inventory,summary,registryRevisions}=await combineDraftInventories(lists,sources,inputDigests,registry);
  const report={format:'dl30-swiss-pc-exclusion-review-v1',basePackageSha256:packageDigest,
    ...(registryRevisions ? {sharedRegistry:{revisions:registryRevisions}} : {}),
    archives,reviews,...summary,valveSeriesWithoutVerifiedOpenDotaLink:history.valveSeriesWithoutVerifiedOpenDotaLink,
    archiveMapCountWithoutSeries:history.mapsWithoutSeriesInTheseArchives,
    peerDatabaseReportProvided:!!peerPath,completeGlobalInventory:false,targetMembershipCompared:false,registrationAllowed:false};
  return {inventory,report};
}
async function main(args) {
  if(args[0]==='check-series') {
    const [,native,meeting,...maps]=args;
    assert(native && meeting && maps.length,'usage: check-series OPENDOTA_ID|- PANDASCORE_ID|- MAP_ID [...]');
    const target={mapIds:sorted(maps.map(id)),openDotaSeriesIds:native==='-'?[]:[id(native)],
      pandaScoreMeetingIds:meeting==='-'?[]:[id(meeting)]};
    const {inventory,revisions,observedAt}=await sharedExposure(process.env.RESEARCH_DATABASE_URL);
    const matches=empty();
    for(const field of Object.keys(matches)){
      const known=new Set(inventory[field]);
      matches[field]=target[field].filter(value=>known.has(value));
    }
    const overlap=Object.values(matches).some(values=>values.length);
    const status=overlap?'known_overlap':revisions.length?'no_known_overlap':'registry_empty';
    console.log(JSON.stringify({status,observedAt,revisions,target,matches,registrationAllowed:false}));
    return;
  }
  const shared=args.at(-1)==='--shared';
  if(shared) assert(process.env.RESEARCH_DATABASE_URL,'RESEARCH_DATABASE_URL required');
  const [output,localPath,localSha,peerPath,peerSha,...rest]=shared ? args.slice(0,-1) : args;
  assert(output&&(localPath||shared)&&!rest.length,'usage: NEW_REPORT [LOCAL_REPORT LOCAL_SHA [PEER_REPORT PEER_SHA]] [--shared]');
  const {report}=await readPcInventories(localPath,localSha,peerPath,peerSha,
    {connectionString:process.env.RESEARCH_DATABASE_URL,publish:true});
  const bytes=JSON.stringify(report,null,2)+'\n';
  await writeFile(output,bytes,{flag:'wx'});
  console.log(JSON.stringify({sha256:sha(bytes),added:counts(report.added),total:report.total,peerDatabaseReportProvided:!!peerPath,
    ...(report.sharedRegistry ? {sharedRevisions:report.sharedRegistry.revisions.length} : {})}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main(process.argv.slice(2));
