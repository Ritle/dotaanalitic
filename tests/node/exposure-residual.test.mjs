import test from 'node:test';
import assert from 'node:assert/strict';
import {atPointer,classifyOpaque,classifyResidual,reviewDryRunAliases} from '../../tools/research/exposure-residual-core.mjs';
import {verifyResidual} from '../../tools/research/exposure-residual.mjs';
const o=path=>({path,reason:'synthetic-test'});
test('JSON pointers distinguish literal keys and embedded JSON; missing fields fail',()=>{
 assert.equal(atPointer({raw:'{"a/b":{"~x":true}}'},'/raw/@json/a~1b/~0x'),true);
 assert.throws(()=>atPointer({},'/missing'),/missing_pointer/);
});
test('API booleans and summary counts are not IDs, but only at approved paths and types',()=>{
 const f='docs/evidence/stratz-api-review-2026-11-02.json';
 assert.equal(classifyOpaque(f,o('/sample/agreement/matchId'),false),'comparison_boolean_not_id');
 assert.equal(classifyOpaque(f,o('/sample/agreement/matchId'),'123'),'unclassified');
 assert.equal(classifyOpaque('docs/evidence/s3-04-player-hero-independent-validation-plan.json',o('/checks/oracle/seriesKeys'),1096),'summary_count_not_id_list');
 assert.equal(classifyOpaque('other.json',o('/checks/oracle/seriesKeys'),1096),'unclassified');
});
test('schema tokens and display names cannot become native map evidence',()=>{
 assert.equal(classifyOpaque('.tools/catalogue-registry.json',o('/data/0/team_name'),'[PeaDoors]'),'display_name_not_identity');
 assert.equal(classifyOpaque('docs/evidence/stratz-api-review-2026-11-02.json',o('/schema/projection/0/type'),'[Long]!'),'graphql_type_declaration');
 assert.equal(classifyOpaque('docs/evidence/stratz-api-review-2026-11-02.json',o('/schema/projection/0/type'),'[123]'),'unclassified');
});
test('unknown contexts stay unknown, extra hidden values prevent disposition',()=>{
 const f='.tools/s1-08-patch-inventory-reviewed.json',p=o('/maps/0/contexts/pre_match/series_id');
 const v={status:'unavailable',reasons:['MISSING'],observationIds:[]};
 assert.equal(classifyOpaque(f,p,v),'explicit_unknown_series_context');
 assert.equal(classifyOpaque(f,p,{...v,value:'123'}),'unclassified');
});
test('news/chat narrative is explicit scope exclusion, embedded match reference stays unresolved',()=>{
 const f='.tools/valve-steam-news.json',p=o('/appnews/newsitems/0/contents');
 assert.equal(classifyOpaque(f,p,'{STEAM_CLAN_IMAGE} tournament news'),'narrative_news_outside_machine_inventory');
 assert.equal(classifyOpaque(f,p,'See https://stratz.com/matches/123'),'unresolved_text_reference');
});
test('local UUID aliases require known native map/series pairs and matching outcome links',()=>{
 const alias='123e4567-e89b-42d3-a456-426614174000';
 const x={status:'PASS',workingDatabaseWrites:0,isolatedDatabaseDropped:true,series:{mappings:[{seriesId:alias,providerSeriesId:'2',mapIds:['1']}]},outcomes:[{seriesId:alias,matchId:'1'}]};
 const ledger={maps:[{matchId:'1',seriesKeys:['["opendota","2"]']}]};assert.equal(reviewDryRunAliases(x,ledger).size,1);
 x.outcomes[0].matchId='3';assert.throws(()=>reviewDryRunAliases(x,ledger),/outcome_alias_binding/);
});
test('synthetic classification depends on both input flags, not map-number coincidence',()=>{
 const f='.tools/s304-prospective-feature-input-r1.json',x={format:'player-hero-prospective-features-input-v1',capture:{syntheticOnly:true},history:{syntheticOnly:true}};
 assert.equal(classifyResidual(f,x,{}, {},[]).complete,true);x.history.syntheticOnly=false;assert.throws(()=>classifyResidual(f,x,{}, {},[]),/synthetic_flags/);
});
test('Valve namespace keeps unknown OpenDota aliases and rejects an uncovered map',()=>{
 const file='valve.json',x={series_infos:[{series_id:2,match_ids:[1,0]}]},e=[{source:{path:file},provider:'valve',providerSeriesId:'2',mapIds:['1']}];
 const r=classifyResidual(file,x,{}, {mapIds:['1']},e);assert.equal(r.canonicalAliasesCreated,0);
 assert.throws(()=>classifyResidual(file,x,{}, {mapIds:[]},e),/uncovered_valve_map/);
});
test('unknown field stays incomplete; replay requires external hash before reading files',async()=>{
 const r=classifyResidual('unknown.json',{value:'[123]'}, {unresolvedReferences:[],opaque:[o('/value')]},{},[]);
 assert.equal(r.complete,false);assert.equal(r.fields[0].category,'unclassified');
 await assert.rejects(verifyResidual('.tools/missing.json'),/external_sha_required/);
});
