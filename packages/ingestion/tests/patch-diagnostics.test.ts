// SYNTHETIC transport data only; no fixture can promote a patch or model.
import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {type PatchDiagnosticsConfig} from '@dota/contracts';
import {diagnoseCorpusPatches,type PatchDiagnosticSnapshot} from '../src/valve/patch-diagnostics.js';

const time='2025-01-01T00:00:00.000Z',revision='a'.repeat(40),id='9007199254740993';
const source={endpoint:'/matches/'+id,fetched_at:time,payload_sha256:'b'.repeat(64),adapter_version:'synthetic-patch-diagnostic'};
const row=(changes:Partial<{match_id:string;started_at:string|null;provider_patch_id:number|string|null;flags:{confirmed_pro:boolean|null}}>={})=>({
  match_id:id,started_at:'2024-10-01T00:00:00.000Z',provider_patch_id:1 as number|string|null,
  league_id:'77',flags:{confirmed_pro:true as boolean|null},source_evidence:source,...changes});
const baseConstants=[{id:0,name:'7.40',date:'2024-01-01T00:00:00.000Z'},{id:1,name:'7.41',date:'2024-03-01T00:00:00.000Z'}];
const baseFeed=[{patch_number:'7.41',patch_timestamp:Date.parse('2024-03-01T00:00:00.000Z')/1000},
  {patch_number:'7.41f',patch_timestamp:Date.parse('2024-09-01T00:00:00.000Z')/1000}];
function fixture(options:{rows?:ReturnType<typeof row>[];constants?:typeof baseConstants;feed?:typeof baseFeed;
  fetchedAt?:string;generatedAt?:string}={}){
  const snapshots:PatchDiagnosticSnapshot[]=[];
  const add=(kind:PatchDiagnosticSnapshot['kind'],data:unknown)=>{
    const content=JSON.stringify(data),sha256=createHash('sha256').update(content).digest('hex');
    snapshots.push({kind,sha256,content});return {path:kind+'.json',sha256};
  };
  const maps=add('maps',{schema_version:3,mode:'live_opendota',generated_at:options.generatedAt??'2025-01-02T00:00:00.000Z',
    status:'complete',source_evidence:[source],observations:options.rows??[row()]});
  const provider=add('provider_patches',options.constants??baseConstants);
  const valve=add('valve_list',{data:{success:true,patches:options.feed??baseFeed},source:{
    url:'https://www.dota2.com/datafeed/patchnoteslist?language=english',adapterVersion:'valve-patch-audit-v1',
    fetchedAt:options.fetchedAt??time,knownAt:null,payloadSha256:'c'.repeat(64),attempts:1}});
  const config:PatchDiagnosticsConfig={schemaVersion:1,snapshotAt:'2025-02-01T00:00:00.000Z',mapCaptures:[maps],
    providerPatches:{...provider,fetchedAt:time,revision,sourceUrl:`https://raw.githubusercontent.com/odota/dotaconstants/${revision}/build/patch.json`},valveList:valve};
  return {config,snapshots};
}
const run=(f=fixture())=>diagnoseCorpusPatches(f.config,f.snapshots);

it('keeps coarse version and last publication separate while open intervals stay unverified',()=>{
  const r=run();expect(r.maps[0]).toMatchObject({matchId:id,providerCode:'1',providerCoarseLabel:'7.41',
    latestPublishedFeedLabel:'7.41f',nominalBoundedCandidate:null,verifiedPatchId:null,historicalKnownAt:null});
  expect(r.maps[0]!.reasons).toContain('FEED_INTERVAL_OPEN_OR_UNKNOWN');
  expect(r).toMatchObject({networkRequests:0,databaseWrites:0,autoRegistryEligible:false,trainingReady:false,deployable:false});
  expect(r.rawValvePayloadHashVerified).toBe(false);
});
it('reuses the nominal bounded interval only as a candidate and honors the exact lower boundary',()=>{
  const f=fixture({rows:[row({started_at:'2024-09-01T00:00:00.000Z'})],feed:[...baseFeed,
    {patch_number:'7.42',patch_timestamp:Date.parse('2024-12-01T00:00:00.000Z')/1000}]});
  expect(run(f).maps[0]).toMatchObject({latestPublishedFeedLabel:'7.41f',nominalBoundedCandidate:'7.41f',verifiedPatchId:null});
});
it('counts repeated rows/captures as one map and fingerprints independently of reference order',()=>{
  const f=fixture({rows:[row(),row()]});f.config.mapCaptures.push({...f.config.mapCaptures[0]!,path:'another.json'});
  f.snapshots.push({...f.snapshots[0]!});
  const r=run(f);expect(r.summary).toMatchObject({observations:4,uniqueMaps:1,duplicateObservations:3});
  const reverse={config:{...f.config,mapCaptures:[...f.config.mapCaptures].reverse()},snapshots:[...f.snapshots].reverse()};
  expect(run(reverse)).toEqual(r);
});
it('does not choose a format when observations disagree on the provider code',()=>{
  const r=run(fixture({rows:[row(),row({provider_patch_id:0})]})).maps[0]!;
  expect(r).toMatchObject({providerCode:null,providerCoarseLabel:null,observedProviderCodes:['0','1']});expect(r.reasons).toContain('PROVIDER_CODE_CONFLICT');
});
it('reports unknown, missing and partial codes without substituting the recomputed value',()=>{
  const unknown=run(fixture({rows:[row({provider_patch_id:999})]})).maps[0]!;
  expect(unknown.providerCoarseLabel).toBeNull();expect(unknown.reasons).toContain('PROVIDER_CODE_UNKNOWN');
  expect(run(fixture({rows:[row({provider_patch_id:null})]})).maps[0]).toMatchObject({providerCode:null,providerCoarseLabel:null,recomputedProviderCode:'1'});
  const partial=run(fixture({rows:[row(),row({provider_patch_id:null})]})).maps[0]!;
  expect(partial.providerCoarseLabel).toBe('7.41');expect(partial.reasons).toContain('PROVIDER_CODE_PARTIAL');
});
it('rejects the label when a known code disagrees with its time interval, including code zero',()=>{
  const r=run(fixture({rows:[row({provider_patch_id:0})]})).maps[0]!;
  expect(r).toMatchObject({providerCode:'0',providerCoarseLabel:null,recomputedProviderCode:'1'});expect(r.reasons).toContain('PROVIDER_CODE_START_MISMATCH');
  expect(run(fixture({rows:[row({provider_patch_id:0,started_at:'2024-01-01T00:00:00.000Z'})]})).maps[0]?.providerCoarseLabel).toBe('7.40');
});
it('does not silently resolve conflicting map starts or unconfirmed professional status',()=>{
  const conflict=run(fixture({rows:[row(),row({started_at:'2024-10-02T00:00:00.000Z'})]})).maps[0]!;
  expect(conflict).toMatchObject({startedAt:null,providerCoarseLabel:null,latestPublishedFeedLabel:null});
  const unverified=run(fixture({rows:[row({flags:{confirmed_pro:null}})]}));
  expect(unverified.summary.proConfirmedMaps).toBe(0);expect(unverified.maps[0]?.providerCoarseLabel).toBeNull();
});
it('keeps a tied latest Valve publication unknown and rejects duplicate feed labels',()=>{
  const f=fixture({feed:[...baseFeed,{patch_number:'7.41g',patch_timestamp:baseFeed[1]!.patch_timestamp}]});
  expect(run(f).maps[0]?.latestPublishedFeedLabel).toBeNull();expect(run(f).maps[0]?.reasons).toContain('VALVE_FEED_BOUNDARY_AMBIGUOUS');
  expect(()=>run(fixture({feed:[...baseFeed,baseFeed[0]!]}))).toThrow('VALVE_PATCH_LABEL_CONFLICT');
});
it('rejects ambiguous provider dates and nonpositional IDs instead of sorting away conflicts',()=>{
  expect(()=>run(fixture({constants:[baseConstants[0]!,{...baseConstants[1]!,date:baseConstants[0]!.date}]}))).toThrow('PROVIDER_PATCH_TIMELINE_INVALID');
  expect(()=>run(fixture({constants:[baseConstants[0]!,{...baseConstants[1]!,id:7}]}))).toThrow('PROVIDER_PATCH_TIMELINE_INVALID');
});
it('accepts native second-precision provider dates and normalizes the exact boundary',()=>{
  const r=run(fixture({constants:baseConstants.map(p=>({...p,date:p.date.replace('.000Z','Z')})),
    rows:[row({started_at:'2024-03-01T00:00:00.000Z'})]}));
  expect(r.maps[0]).toMatchObject({recomputedProviderCode:'1',providerCoarseLabel:'7.41'});
});
it('fails closed on tampered bytes and unmatched snapshot sets',()=>{
  const f=fixture();f.snapshots[0]!.content+=' ';
  expect(()=>run(f)).toThrow('SNAPSHOT_SHA_MISMATCH');
  const missing=fixture();missing.snapshots.pop();expect(()=>run(missing)).toThrow('SNAPSHOT_SET_MISMATCH');
});
it('rejects future source knowledge and contradictory capture clocks',()=>{
  expect(()=>run(fixture({fetchedAt:'2026-01-01T00:00:00.000Z'}))).toThrow('SOURCE_AFTER_SNAPSHOT');
  const f=fixture();f.config.providerPatches.fetchedAt='2026-01-01T00:00:00.000Z';expect(()=>run(f)).toThrow('SOURCE_AFTER_SNAPSHOT');
  expect(()=>run(fixture({generatedAt:'2024-12-01T00:00:00.000Z'}))).toThrow('CAPTURE_CLOCK_INVALID');
  expect(()=>run(fixture({rows:[row({started_at:'2025-01-03T00:00:00.000Z'})]}))).toThrow('MAP_AFTER_CAPTURE');
});
it('explicit selection cannot silently omit a missing map and zero sample remains empty',()=>{
  const f=fixture();f.config.matchIds=['2'];expect(()=>run(f)).toThrow('MATCH_SELECTION_NOT_FOUND');
  const empty=run(fixture({rows:[]}));expect(empty.summary).toMatchObject({uniqueMaps:0,observations:0});expect(empty.maps).toEqual([]);
  expect(run()).toEqual(run());
});
