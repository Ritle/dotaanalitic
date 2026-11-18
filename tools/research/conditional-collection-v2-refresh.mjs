/** Additive explicit sweep control. Frozen runtime retains transport, budgets and recovery. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {sql} from '../../packages/db/dist/index.js';
import {archiveSha as sha} from './conditional-blob-archive.mjs';
import {parseBindingEvidenceJson as parse} from './conditional-tournament-binding-v2.mjs';
import {CollectionV2RuntimeRequest,LocalConditionalCollectionV2Runtime,collectionV2RuntimeManifestPaths,verifyCollectionV2RuntimeManifest} from './conditional-collection-v2-runtime.mjs';
import {ConditionalCollectionV2Discovery} from './conditional-collection-v2-discovery.mjs';
const Id=z.string().uuid().transform(v=>v.toLowerCase()),Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Sweep=z.discriminatedUnion('action',[
 z.object({action:z.literal('begin'),sweepId:Id,expectedHeadSha256:Hash}).strict(),
 z.object({action:z.literal('resume'),sweepId:Id}).strict()
]);
export const CollectionV2RefreshRequest=CollectionV2RuntimeRequest.extend({sweep:Sweep}).strict();
export const collectionV2RefreshPaths=['tools/research/conditional-collection-v2-refresh.mjs','tools/research/run-conditional-collection-v2-refresh.mjs',
 'packages/db/migrations/070_conditional_collection_v2_sweeps.sql'];
export async function collectionV2RefreshManifestPaths(){return [...new Set([...await collectionV2RuntimeManifestPaths(),...collectionV2RefreshPaths])].sort();}
async function verifyRefreshSources(registration){const p=parse(registration.packageText);
 for(const path of collectionV2RefreshPaths)assert.equal(sha(await readFile(path)),p.executable.code[path],'registered_v2_refresh_code_changed');
}
export async function verifyCollectionV2RefreshManifest(registration){await verifyRefreshSources(registration);
 return verifyCollectionV2RuntimeManifest(registration);
}
const blockers=['COLLECTION_NOT_STARTED','COLLECTION_WINDOW_CLOSED','PROVIDER_AUTH_FAILED','RETRY_AFTER','TOTAL_BUDGET_EXHAUSTED',
 'DAILY_BUDGET_EXHAUSTED','TARGET_BUDGET_EXCEEDED','INVALID_DISCOVERY_RESPONSE','UNKNOWN_REQUEST_OUTCOME_REQUIRES_REVIEW','REQUEST_IN_FLIGHT'];
export function projectCollectionV2Refresh(report,marker,{snapshotAt=report.snapshotAt}={}){
 assert(Number.isInteger(marker.base_request_count)&&marker.base_request_count>=0&&marker.base_request_count<=report.requests.length,'sweep_boundary_count');
 const fresh=report.requests.slice(marker.base_request_count),ids=new Set(fresh.map(q=>q.requestId));
 const leagues=new Set(fresh.filter(q=>q.kind==='league'&&q.status==='projected').map(q=>q.endpoint));
 const current=report.passes.filter(p=>ids.has(p.rootRequestId)).at(-1);
 const league=report.scope.find(s=>!leagues.has('/leagues/'+s.leagueId+'/matches'));
 const missing=report.maps.find(m=>m.possibleTarget&&!m.detailCaptured&&!m.reasons.some(code=>
  ['EXPOSED_MAP_OR_SERIES','METADATA_CONFLICT','LEAGUE_ENDPOINT_CONFLICT','FOREIGN_EVENT','OUTSIDE_WINDOW','START_AFTER_OBSERVATION'].includes(code)));
 const stopped=blockers.some(code=>report.reasons.includes(code));
 const endpoint=stopped?null:league?'/leagues/'+league.leagueId+'/matches':missing?'/matches/'+missing.matchId:
  current?.status==='endpoint_end_observed'?null:current?.cursor?'/proMatches?less_than_match_id='+current.cursor:'/proMatches';
 const reasons=report.reasons.filter(code=>!['LEAGUE_RESPONSE_MISSING','GLOBAL_SCAN_INCOMPLETE'].includes(code));
 if(league)reasons.push('LEAGUE_RESPONSE_MISSING');if(current?.status!=='endpoint_end_observed')reasons.push('GLOBAL_SCAN_INCOMPLETE');
 const {fingerprint:previousFingerprint,...source}=report;
 const sweepStartedAt=marker.created_at?iso(marker.created_at):null;
 if(sweepStartedAt)assert(snapshotAt>=sweepStartedAt&&snapshotAt>=report.snapshotAt,'refresh_snapshot_clock');
 const body={...source,format:'conditional-collection-v2-refresh-report-v1',sweepId:marker.sweep_id,sweepMarkerSha256:marker.marker_sha256,
  snapshotAt,sourceDiscoverySnapshotAt:report.snapshotAt,sweepStartedAt,
  baseRequestCount:marker.base_request_count,sweepComplete:!stopped&&!endpoint,sourceDiscoveryFingerprint:previousFingerprint??null,
  nextRequest:endpoint?{endpoint,advisoryOnly:true}:null,reasons:[...new Set(reasons)].sort()};
 return {...body,fingerprint:sha(JSON.stringify(body))};
}
const iso=x=>new Date(x).toISOString();
// The supplied discovery report was byte-verified before this transaction. The head CAS
// binds it to this boundary; an in-flight reservation is never accepted as a start point.
async function markers(tx,registration,report){
 const rows=(await sql`SELECT * FROM conditional_collection_v2_sweeps WHERE registration_id=${registration.id}::uuid ORDER BY sequence`.execute(tx)).rows;
 assert(rows.length<=1000,'sweep_limit');let previous=null;
 for(const [i,row] of rows.entries()){
  assert.equal(row.sequence,i,'sweep_sequence');assert.equal(row.parent_sha256,previous?.marker_sha256??null,'sweep_parent');
  assert.equal(sha(row.marker_text),row.marker_sha256,'sweep_marker_hash');
  assert.deepEqual(parse(row.marker_text),{format:'conditional-collection-v2-sweep-v1',registrationId:registration.id,
   registrationSha256:registration.packageSha256,sweepId:Id.parse(row.sweep_id),sequence:i,baseHeadSha256:row.base_head_sha256,
   baseRequestCount:row.base_request_count,parentSha256:row.parent_sha256,syntheticOnly:true,createdAt:iso(row.created_at)},'sweep_marker_binding');
  assert(row.base_request_count>(previous?.base_request_count??0)&&row.base_request_count<=report.requests.length,'sweep_request_order');
  const boundary=(await sql`SELECT sequence,event_text,recorded_at FROM conditional_collection_v2_events
   WHERE registration_id=${registration.id}::uuid AND head_sha256=${row.base_head_sha256}`.execute(tx)).rows[0];
  assert(boundary&&parse(boundary.event_text).kind!=='reserved','sweep_boundary_missing_or_pending');
  const n=(await sql`SELECT count(*)::int AS n FROM conditional_collection_v2_events WHERE registration_id=${registration.id}::uuid
   AND sequence<=${boundary.sequence} AND event_text::jsonb->>'kind'='reserved'`.execute(tx)).rows[0].n;
  assert.equal(n,row.base_request_count,'sweep_boundary_count');
  assert(iso(row.created_at)>=iso(boundary.recorded_at)&&iso(row.created_at)>=(previous?iso(previous.created_at):registration.registeredAt)
   &&iso(row.created_at)<=report.snapshotAt&&iso(row.created_at)>=registration.plan.window.from&&iso(row.created_at)<registration.plan.window.assessmentAt,'sweep_clock');
  previous=row;
 }
 return rows;
}
export class ConditionalCollectionV2RefreshDiscovery extends ConditionalCollectionV2Discovery{
 constructor(db,sweep){super(db);this.sweep=Sweep.parse(sweep);}
 async read(ownerId,id){
  const registration=await this.journal.registration(ownerId,id);await verifyRefreshSources(registration);
  const source=await super.read(ownerId,id),report=source.report;
  return this.journal.transaction(ownerId,registration,async(tx,a)=>{
   assert(a.synthetic_only,'refresh_synthetic_only');
   const head=(await sql`SELECT head_sha256 FROM conditional_collection_v2_events WHERE registration_id=${id}::uuid ORDER BY sequence DESC LIMIT 1`.execute(tx)).rows[0]?.head_sha256
    ??(await sql`SELECT header_sha256 FROM conditional_collection_v2_journals WHERE registration_id=${id}::uuid`.execute(tx)).rows[0]?.header_sha256;
   assert.equal(head,report.journalHeadSha256,'refresh_snapshot_changed_retry');
   const rows=await markers(tx,registration,report),last=rows.at(-1);let marker=rows.find(row=>row.sweep_id===this.sweep.sweepId);
   if(marker){
    assert.equal(marker.sweep_id,last.sweep_id,'sweep_superseded');
    if(this.sweep.action==='begin')assert.equal(marker.base_head_sha256,this.sweep.expectedHeadSha256,'sweep_idempotency_conflict');
   }else{
    assert.equal(this.sweep.action,'begin','sweep_not_found');assert.equal(head,this.sweep.expectedHeadSha256,'sweep_expected_head');
    assert(!blockers.some(code=>report.reasons.includes(code)),'sweep_blocked');
    const previous=last?projectCollectionV2Refresh(report,last):report;
    assert(last?previous.sweepComplete:!previous.nextRequest,'previous_sweep_incomplete');
    assert(report.requests.length>0,'initial_sweep_required');
    marker=(await sql`INSERT INTO conditional_collection_v2_sweeps(registration_id,sweep_id,sequence,base_head_sha256,base_request_count,parent_sha256)
     VALUES(${id}::uuid,${this.sweep.sweepId}::uuid,${rows.length},${head},${report.requests.length},${last?.marker_sha256??null}) RETURNING *`.execute(tx)).rows[0];
   }
   const snapshotAt=iso((await sql`SELECT conditional_collection_clock() AS at`.execute(tx)).rows[0].at);
   return {...source,report:projectCollectionV2Refresh(report,marker,{snapshotAt})};
  });
 }
}
export class LocalConditionalCollectionV2RefreshRuntime{
 constructor(db){this.db=db;}
 async run(raw,{signal}={}){
  const input=CollectionV2RefreshRequest.parse(raw),{sweep,...base}=input;
  const runtime=new LocalConditionalCollectionV2Runtime(this.db);
  runtime.discovery=new ConditionalCollectionV2RefreshDiscovery(this.db,sweep);
  // Verification is inside the frozen runtime's timer, before writes and before its session lock.
  const read=runtime.journal.registration.bind(runtime.journal);
  // The frozen runtime verifies the complete declared code and environment immediately
  // after this read; only require the added sources here, without a duplicate environment probe.
  runtime.journal.registration=async(...args)=>{const r=await read(...args);await verifyRefreshSources(r);return r;};
  const result=await runtime.run(base,{signal});
  return {...result,format:'conditional-local-collection-refresh-v2',requestedSweepId:sweep.sweepId,
   sweepComplete:result.status==='complete',sweepMarkerPersistence:result.discoveryFingerprint?'verified':'not_reported'};
 }
}
