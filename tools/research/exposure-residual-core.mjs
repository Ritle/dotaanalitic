/** Classify a fixed audited residual set. Never a universal text-to-identity parser. */
import assert from 'node:assert/strict';
import {sha,id} from './exposure-ledger-core.mjs';
import {syntheticArchive} from './exposure-archive-triage.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function atPointer(x,p){
 assert(typeof p==='string'&&p.startsWith('/'),'pointer');
 for(const t of p.slice(1).split('/')){
  if(t==='@json'){assert(typeof x==='string','embedded_json');x=JSON.parse(x);}
  else {const k=t.replaceAll('~1','/').replaceAll('~0','~');assert(x!==null&&typeof x==='object'&&Object.hasOwn(x,k),'missing_pointer');x=x[k];}
 }return x;
}
export function reviewDryRunAliases(x,ledger){
 assert.equal(x.status,'PASS');assert.equal(x.workingDatabaseWrites,0);assert.equal(x.isolatedDatabaseDropped,true);
 const maps=new Map(ledger.maps.map(m=>[m.matchId,m.seriesKeys])),aliases=new Map();
 for(const m of x.series.mappings){assert(uuid.test(m.seriesId),'local_uuid');id(m.providerSeriesId);
  assert(!aliases.has(m.seriesId),'duplicate_alias');assert(Array.isArray(m.mapIds)&&m.mapIds.length>0,'alias_maps');
  for(const n of m.mapIds){id(n);assert(maps.get(n)?.includes(JSON.stringify(['opendota',m.providerSeriesId])),'alias_native_binding');}
  aliases.set(m.seriesId,new Set(m.mapIds));}
 for(const o of x.outcomes)if(o.seriesId!==null)assert(aliases.get(o.seriesId)?.has(o.matchId),'outcome_alias_binding');
 return aliases;
}
const registries=new Set(['.tools/catalogue-registry.json','.tools/s1-12-current-capture.json','.tools/s1-12-registry.json',
 '.tools/s1-21-current-capture.json','.tools/tier1-participants-sources/registry-cache.json','.tools/v1-historical-import-20261106/registry.json']);
const apiFiles=new Set(['.tools/s1-07-active-version-source/api-list.json','docs/evidence/s1-07-active-version-api-list.json']);
export function classifyOpaque(file,o,value,aliases=new Map()){
 const p=o.path;
 if(registries.has(file)&&p.endsWith('/team_name')&&typeof value==='string'&&value.length<=512)return 'display_name_not_identity';
 if(file==='.tools/label-audit-20261111/template-inventory.json'&&/^\/files\/\d+\/templateCandidateLines\/\d+\/text$/.test(p)&&typeof value==='string'&&value.startsWith('{{'))return 'vue_template_source';
 if(apiFiles.has(file)&&/^\/apilist\/interfaces\/\d+\/methods\/\d+\/parameters\/\d+\/(type|description)$/.test(p)&&
  typeof value==='string'&&(/^\{(message|enum)\}$/.test(value)||value.startsWith('[ENetQOSLevel]')))return 'api_schema_declaration';
 if(file==='docs/evidence/stratz-api-review-2026-11-02.json'){
  if(p.startsWith('/schema/projection/')&&p.endsWith('/type')&&typeof value==='string'&&/^\[[A-Za-z_]\w*!?\]!?$/.test(value))return 'graphql_type_declaration';
  if(['/sample/agreement/matchId','/sample/agreement/seriesId'].includes(p)&&typeof value==='boolean')return 'comparison_boolean_not_id';
 }
 if(file==='.tools/s1-08-patch-inventory-reviewed.json'&&/^\/maps\/\d+\/contexts\/(pre_match|post_draft)\/series_id$/.test(p)){
  if(JSON.stringify(value)===JSON.stringify({status:'unavailable',reasons:['MISSING'],observationIds:[]}))return 'explicit_unknown_series_context';
 }
 if(file==='.tools/s304-history-import-dry-run-r1/report.json'&&/^\/(series\/mappings|outcomes)\/\d+\/seriesId$/.test(p)&&aliases.has(value))return 'isolated_test_database_alias';
 if(file==='docs/evidence/s3-04-player-hero-independent-validation-plan.json'&&p==='/checks/oracle/seriesKeys'&&Number.isSafeInteger(value)&&value>=0)return 'summary_count_not_id_list';
 const news=file==='.tools/valve-steam-news.json'&&/^\/appnews\/newsitems\/\d+\/contents$/.test(p);
 const chat=file==='.tools/v1-retest-collection-20261106/store/outcomes/map-8654581479.1.json'&&/^\/record\/observation\/rawBody\/@json\/chat\/\d+\/key$/.test(p);
 if((news||chat)&&typeof value==='string'){
  if(/(?:\/(?:matches|match)\/\d+|\bmatch_?id\s*[:=]\s*\d+)/i.test(value))return 'unresolved_text_reference';
  return news?'narrative_news_outside_machine_inventory':'chat_text_outside_machine_inventory';
 }
 return 'unclassified';
}
export function classifyResidual(file,x,review,ledger,valveEvidence){
 const fixtureFiles=['.tools/s304-prospective-feature-input-r1.json','.tools/s304-prospective-feature-parity-cases.json'];
 if(fixtureFiles.includes(file)){assert(syntheticArchive(x),'synthetic_flags');return {file,kind:'verified_synthetic_input',complete:true,fields:[],newNativeMaps:0};}
 const groups=valveEvidence.filter(g=>g.source.path===file);
 if(groups.length){
  assert(Array.isArray(x.series_infos)&&x.series_infos.length===groups.length,'valve_group_count');
  for(const [i,s] of x.series_infos.entries()){
   const g=groups[i];assert.equal(String(s.series_id),g.providerSeriesId);assert.equal(g.provider,'valve');
   const ids=[...new Set(s.match_ids.filter(v=>v!==0&&v!=='0').map(v=>{assert(typeof v==='string'||Number.isSafeInteger(v),'unsafe_id');return id(String(v));}))];
   assert.deepEqual(ids,g.mapIds,'valve_map_list');assert(ids.every(n=>ledger.mapIds.includes(n)),'uncovered_valve_map');
  }
  return {file,kind:'valve_series_namespace',complete:true,fields:[],groups:groups.length,canonicalAliasesCreated:0,newNativeMaps:0};
 }
 const aliases=file==='.tools/s304-history-import-dry-run-r1/report.json'?reviewDryRunAliases(x,ledger):new Map();
 assert.equal(review.unresolvedReferences.length,0,'unresolved_reference_not_disposed');
 const fields=review.opaque.map(o=>{const value=atPointer(x,o.path);return {path:o.path,originalReason:o.reason,
  category:classifyOpaque(file,o,value,aliases),valueSha256:sha(JSON.stringify(value))};});
 return {file,kind:'field_dispositions',fields,complete:fields.every(f=>!['unclassified','unresolved_text_reference'].includes(f.category)),
  localAliasesReviewed:aliases.size,canonicalAliasesCreated:0,newNativeMaps:0};
}
