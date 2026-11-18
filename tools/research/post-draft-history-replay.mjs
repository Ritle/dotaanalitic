import assert from 'node:assert/strict';
import {digest,sha} from './post-draft-dataset.mjs';
import {parseSource,HeroesSchema,LeaguesSchema} from '../../packages/ingestion/dist/index.js';

export const REPLAY_ADAPTER='opendota-projection-replay-v1';

export function validateDryRunScope(proposal,plan){
 assert.equal(proposal.scope,'isolated_test_database_only');
 for(const key of ['providerHttpAllowed','workingDatabaseWritesAllowed','trainingAllowed','activationAllowed'])assert.equal(proposal[key],false,key);
 const ids=plan.maps.filter(m=>m.status==='planned_for_isolated_dry_run'&&!m.reasons.length).map(m=>m.matchId);
 assert(ids.length>0);assert.equal(new Set(ids).size,ids.length);assert.deepEqual(proposal.mapIds,ids);
 assert.equal(plan.status,'requires_isolated_dry_run');assert.equal(plan.deployable,false);
 return ids;
}

/** Only an internally generated local clone may be passed to the importer. */
export function assertIsolatedTarget(sourceUrl,targetUrl,generatedName,currentDatabase){
 const source=new URL(sourceUrl),target=new URL(targetUrl);
 assert(['postgresql:','postgres:'].includes(source.protocol));
 assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname));
 assert(/^codex_s304_dry_[a-f0-9]{16}$/.test(generatedName));
 assert.equal(currentDatabase,generatedName);
 assert.notEqual(decodeURIComponent(source.pathname.slice(1)),generatedName);
 assert.equal(decodeURIComponent(target.pathname.slice(1)),generatedName);
 source.pathname='/';target.pathname='/';assert.equal(target.toString(),source.toString());
}

export function createProjectionReplay(proposal,plan,report,capture){
 const ids=validateDryRunScope(proposal,plan),observations=new Map(),lineage=[];
 for(const matchId of ids){
  const selected=plan.maps.find(m=>m.matchId===matchId),rows=report.rows.filter(r=>r.matchId===matchId);
  assert.equal(rows.length,1);const row=rows[0],receipt=row.receipt;
  assert.equal(row.status,'observed');assert.equal(row.assessment.sourceConsistent,true);assert.deepEqual(row.assessment.coverageReasons,[]);
  assert.deepEqual(receipt.sourceIssues,[]);assert.equal(receipt.originalResponseBytesRetained,false);
  assert.equal(digest(receipt.source),digest(selected.source));
  const rawBody=JSON.stringify(receipt.projection),projectionSha=sha(rawBody);
  assert.equal(projectionSha,receipt.projectionSha256);assert.equal(projectionSha,selected.projectionSha256);
  assert.equal(selected.replay.adapterVersion,REPLAY_ADAPTER);assert.equal(selected.replay.payloadSha256,projectionSha);
  assert.equal(selected.replay.originalPayloadSha256,receipt.source.payloadSha256);
  assert.equal(selected.replay.knownAt,null);assert.equal(selected.replay.originalResponseBytesRetained,false);
  assert.equal(receipt.source.provider,'opendota');assert.equal(receipt.source.endpoint,`/matches/${matchId}`);
  assert.equal(receipt.source.knownAt,null);assert.match(receipt.source.payloadSha256,/^[a-f0-9]{64}$/);
  assert(!('synthetic' in receipt.projection)&&!('_fixture' in receipt.projection));
  const observation={data:structuredClone(receipt.projection),rawBody,source:{...receipt.source,adapterVersion:REPLAY_ADAPTER,payloadSha256:projectionSha,attempts:0}};
  const parsed=parseSource(observation,matchId);assert(parsed.match);assert.deepEqual(parsed.issues,[]);
  const actual=parsed.match.players.map(p=>({slot:p.player_slot,accountId:p.account_id,heroId:p.hero_id})).sort((a,b)=>a.slot-b.slot);
  const expected=selected.members.map(m=>({slot:m.slot,accountId:m.accountId,heroId:m.heroId})).sort((a,b)=>a.slot-b.slot);
  assert.deepEqual(actual,expected);assert.equal(actual.length,10);
  assert.equal(new Set(actual.map(p=>p.accountId)).size,10);assert.equal(new Set(actual.map(p=>p.heroId)).size,10);
  assert.deepEqual(actual.map(p=>p.slot),[0,1,2,3,4,128,129,130,131,132]);
  observations.set(matchId,observation);
  lineage.push({matchId,adapterVersion:REPLAY_ADAPTER,projectionSha256:projectionSha,originalSource:structuredClone(receipt.source),
   originalResponseBytesRetained:false,knownAt:null,storage:'immutable_dry_run_sidecar'});
 }
 const reference=endpoint=>{
  const rows=capture.references.filter(r=>r.endpoint===endpoint);assert.equal(rows.length,1);const r=rows[0];
  const data=(endpoint==='/heroes'?HeroesSchema:LeaguesSchema).parse(r.source_payload);
  assert.match(r.payload_sha256,/^[a-f0-9]{64}$/);assert(Number.isFinite(Date.parse(r.fetched_at)));
  // Reuse the stored normalized reference observation; do not fabricate raw bytes.
  return {data,source:{provider:'opendota',endpoint,adapterVersion:r.adapter_version,payloadSha256:r.payload_sha256,
   fetchedAt:r.fetched_at,knownAt:null,attempts:0},cachedReferenceId:r.id};
 };
 const heroes=reference('/heroes'),leagues=reference('/leagues');
 return {lineage,provider:{
  async getMatchSource(id){assert(observations.has(id),'map_outside_plan');return structuredClone(observations.get(id));},
  async getHeroes(){return structuredClone(heroes);},async getLeagues(){return structuredClone(leagues);}
 }};
}
