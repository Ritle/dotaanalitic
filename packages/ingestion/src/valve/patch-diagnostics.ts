import {createHash} from 'node:crypto';
import {PatchDiagnosticsConfigSchema,PatchDiagnosticMapCaptureSchema,ProviderPatchConstantsSchema,
  ValvePatchListObservationSchema,type PatchDiagnosticsConfig} from '@dota/contracts';
import {assessAuditedMapPatches} from './patch-audit.js';

export type PatchDiagnosticSnapshot={kind:'maps'|'provider_patches'|'valve_list';sha256:string;content:string};
const hash=(content:string)=>createHash('sha256').update(content).digest('hex');
const compareIds=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
export class PatchDiagnosticsError extends Error{
  constructor(readonly code:string){super(code);}
}
const fail=(code:string):never=>{throw new PatchDiagnosticsError(code);};

/** Offline source diagnostics only. No repository, network, release proof or model writer. */
export function diagnoseCorpusPatches(input:PatchDiagnosticsConfig,snapshots:readonly PatchDiagnosticSnapshot[]){
  const q=PatchDiagnosticsConfigSchema.parse(input);
  if(snapshots.length!==q.mapCaptures.length+2)fail('SNAPSHOT_SET_MISMATCH');
  const remaining=[...snapshots];
  const load=(kind:PatchDiagnosticSnapshot['kind'],sha256:string)=>{
    const i=remaining.findIndex(s=>s.kind===kind&&s.sha256===sha256);if(i<0)fail('SNAPSHOT_SET_MISMATCH');
    const [s]=remaining.splice(i,1);if(hash(s!.content)!==sha256)fail('SNAPSHOT_SHA_MISMATCH');
    try{return JSON.parse(s!.content) as unknown;}catch{fail('SNAPSHOT_JSON_INVALID');}
  };
  const captures=q.mapCaptures.map(ref=>PatchDiagnosticMapCaptureSchema.parse(load('maps',ref.sha256)));
  const constants=ProviderPatchConstantsSchema.parse(load('provider_patches',q.providerPatches.sha256));
  const valve=ValvePatchListObservationSchema.parse(load('valve_list',q.valveList.sha256));
  if(constants.some((p,i)=>p.id!==i||i>0&&p.date<=constants[i-1]!.date))fail('PROVIDER_PATCH_TIMELINE_INVALID');
  if(new Set(valve.data.patches.map(p=>p.patch_number)).size!==valve.data.patches.length)fail('VALVE_PATCH_LABEL_CONFLICT');
  if(q.providerPatches.fetchedAt>q.snapshotAt||valve.source.fetchedAt>q.snapshotAt||captures.some(c=>
    c.generated_at>q.snapshotAt||c.source_evidence.some(s=>s.fetched_at>q.snapshotAt)||c.observations.some(m=>
      m.source_evidence!==null&&m.source_evidence.fetched_at>q.snapshotAt)))fail('SOURCE_AFTER_SNAPSHOT');
  if(captures.some(c=>c.source_evidence.some(s=>s.fetched_at>c.generated_at)||c.observations.some(m=>
    m.source_evidence!==null&&m.source_evidence.fetched_at>c.generated_at)))fail('CAPTURE_CLOCK_INVALID');
  if(captures.some(c=>c.observations.some(m=>m.started_at!==null&&m.started_at>c.generated_at)))fail('MAP_AFTER_CAPTURE');
  const selected=q.matchIds?new Set(q.matchIds):null;
  const observations=captures.flatMap(c=>c.observations).filter(m=>!selected||selected.has(m.match_id));
  const byMap=new Map<string,typeof observations>();
  for(const m of observations){const rows=byMap.get(m.match_id)??[];rows.push(m);byMap.set(m.match_id,rows);}
  if(selected&&[...selected].some(id=>!byMap.has(id)))fail('MATCH_SELECTION_NOT_FOUND');
  // Reuse the source auditor's pro/start consistency and nominal interval rules.
  const coverage=assessAuditedMapPatches(captures.map(c=>({...c,observations:c.observations.filter(m=>!selected||selected.has(m.match_id))})),valve);
  const feed=[...valve.data.patches].sort((a,b)=>a.patch_timestamp-b.patch_timestamp||a.patch_number.localeCompare(b.patch_number));
  const maps=[...byMap].sort(([a],[b])=>compareIds(a,b)).map(([matchId,rows])=>{
    const assessed=coverage.maps.find(m=>m.matchId===matchId)!;
    const reasons=new Set(assessed.reasons),proConfirmed=rows.every(m=>m.flags.confirmed_pro===true);
    const startedAt=assessed.startedAt;
    const codes=[...new Set(rows.flatMap(m=>m.provider_patch_id===null?[]:[String(m.provider_patch_id)]))].sort(compareIds);
    let providerCode=codes.length===1?codes[0]!:null,recomputedProviderCode:string|null=null,providerCoarseLabel:string|null=null;
    if(!proConfirmed)reasons.add('PRO_STATUS_UNVERIFIED');
    if(codes.length>1)reasons.add('PROVIDER_CODE_CONFLICT');
    if(rows.some(m=>m.provider_patch_id===null))reasons.add(codes.length?'PROVIDER_CODE_PARTIAL':'PROVIDER_CODE_MISSING');
    const definition=providerCode===null?null:constants.find(p=>String(p.id)===providerCode);
    if(providerCode!==null&&!definition)reasons.add('PROVIDER_CODE_UNKNOWN');
    if(startedAt!==null){
      if(startedAt<constants[0]!.date)reasons.add('START_BEFORE_PROVIDER_TIMELINE');
      else{
        const index=constants.filter(p=>p.date<=startedAt).at(-1)!.id;recomputedProviderCode=String(index);
        if(index===constants.length-1)reasons.add('PROVIDER_INTERVAL_OPEN');
        if(definition&&String(index)!==providerCode)reasons.add('PROVIDER_CODE_START_MISMATCH');
        else if(definition)providerCoarseLabel=definition.name;
      }
    }
    if(!proConfirmed||startedAt===null){providerCode=null;providerCoarseLabel=null;}
    const earlier=feed.filter(p=>startedAt!==null&&p.patch_timestamp*1000<=Date.parse(startedAt)),last=earlier.at(-1);
    const latestRows=last?earlier.filter(p=>p.patch_timestamp===last.patch_timestamp):[];
    if(latestRows.length>1)reasons.add('VALVE_FEED_BOUNDARY_AMBIGUOUS');
    const latest=latestRows.length===1?last:null;
    return {matchId,startedAt,observations:rows.length,proConfirmed,observedProviderCodes:codes,providerCode,
      providerCoarseLabel,recomputedProviderCode,latestPublishedFeedLabel:latest?.patch_number??null,
      latestPublishedFeedTimestamp:latest?new Date(latest.patch_timestamp*1000).toISOString():null,
      nominalBoundedCandidate:assessed.nominalPatchCandidate,verifiedPatchId:null,historicalKnownAt:null,reasons:[...reasons].sort()};
  });
  const sources=[...q.mapCaptures.map(ref=>({kind:'maps' as const,artifactSha256:ref.sha256})),
    {kind:'provider_patches' as const,artifactSha256:q.providerPatches.sha256},
    {kind:'valve_list' as const,artifactSha256:q.valveList.sha256}].sort((a,b)=>a.kind.localeCompare(b.kind)||a.artifactSha256.localeCompare(b.artifactSha256));
  const body={schemaVersion:1,policyVersion:'offline-patch-diagnostics-v1',status:'diagnostic_complete' as const,snapshotAt:q.snapshotAt,
    sources,providerSource:{url:q.providerPatches.sourceUrl,revision:q.providerPatches.revision,fetchedAt:q.providerPatches.fetchedAt},
    valveSource:valve.source,summary:{observations:observations.length,uniqueMaps:maps.length,
      duplicateObservations:observations.length-maps.length,proConfirmedMaps:maps.filter(m=>m.proConfirmed).length,
      providerCoarseLabelMaps:maps.filter(m=>m.providerCoarseLabel!==null).length,
      latestPublishedFeedLabelMaps:maps.filter(m=>m.latestPublishedFeedLabel!==null).length,verifiedPatchMaps:0},maps,
    evidenceScope:'source_diagnostics_only',artifactHashesVerified:true,rawValvePayloadHashVerified:false,
    networkRequests:0,databaseWrites:0,autoRegistryEligible:false,trainingReady:false,deployable:false};
  return {...body,fingerprint:hash(JSON.stringify(body))};
}
