import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {inspectTournamentBindingsV2} from '../../tools/research/conditional-tournament-binding-v2.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const policyText=await readFile('tools/research/player-hero-conditional-future-policy.json','utf8');
const policy=JSON.parse(policyText),at='2026-11-15T16:00:00.000Z';
function fixture(){
 const input={format:'conditional-tournament-binding-review-v2',policySha256:sha(policyText),syntheticOnly:true,
  reviewedAt:'2026-11-15T01:00:00.000Z',reviewerUserId:'11111111-1111-4111-8111-111111111111',sources:[],bindings:[]};
 const source=(id,url,bodyText)=>{input.sources.push({id,url,bodyText,sha256:sha(bodyText),fetchedAt:'2026-11-15T00:00:00.000Z',knownAt:null,
  httpStatus:200,representation:'retained_http_utf8'});return id;};
 const catalogue=source('catalogue','https://api.opendota.com/api/leagues',JSON.stringify(policy.proposedRegistration.events.map((e,i)=>({leagueid:90001+i,name:e.name,tier:'professional',ticket:null,banner:null}))));
 for(const [i,e] of policy.proposedRegistration.events.entries()){
  const leagueId=String(90001+i),period=e.fromDate+' through '+e.throughDate;
  const calendar=source('calendar'+i,e.source,'SYNTHETIC TEST ONLY '+e.name+' '+period);
  const href='https://www.opendota.com/leagues/'+leagueId;
  const section=e.name+' 2026 — <a href="'+href+'">League information</a>';
  const link=source('link'+i,new URL('/events/synthetic-'+i,e.source).href,'SYNTHETIC TEST ONLY '+section);
  input.bindings.push({editionKey:e.name,leagueId,calendar:{sourceId:calendar,editionExcerpt:e.name,periodExcerpt:period,
   fromDate:e.fromDate,throughDate:e.throughDate,reviewNote:'Synthetic calendar period and main event reviewed for this test only',
   startBound:{at:e.fromDate+'T00:00:00.000Z',basis:'owner_reviewed_lower_bound',explanation:'Synthetic conservative lower bound before any target series'}},
   native:{sourceId:catalogue},link:{sourceId:link,section,href,reviewNote:'Synthetic explicit organizer link for this edition and native league'}});
 }
 return input;
}
const inspect=p=>inspectTournamentBindingsV2(p,policyText,at);
function editSource(p,id,body){const s=p.sources.find(s=>s.id===id);s.bodyText=body;s.sha256=sha(body);}
test('separate organizer page with native hyperlink works without article URL in catalogue',()=>{
 const p=fixture(),r=inspect(p);assert.equal(r.status,'reviewed_bindings_only');assert(r.bindingsReady);
 assert.equal(r.bindings[0].leagueId,'90001');assert.equal(r.registrationReady,false);assert.equal(r.collectionAllowed,false);
 assert.equal(r.ownerAuthenticated,false);assert.equal(r.deployable,false);assert.equal(r.syntheticOnly,true);
 assert(!p.sources[0].bodyText.includes(policy.proposedRegistration.events[0].source));
 assert.equal(r.bindings[0].evidence.length,3);assert.deepEqual(inspect(p),r);
});
test('bare matching names remain candidates, not verified bindings',()=>{
 const p=fixture();p.bindings[0].link=null;const r=inspect(p);assert.equal(r.status,'unavailable');
 assert(r.bindings[0].reasons.includes('ORGANIZER_NATIVE_LINK_MISSING'));assert.equal(r.bindings[0].leagueId,null);
});
test('missing owner review, calendar, native ID and second edition remain explicit',()=>{
 const p=fixture();p.reviewerUserId=null;p.bindings[0].calendar=null;p.bindings[0].leagueId=null;p.bindings.pop();
 const r=inspect(p);assert(r.reasons.includes('OWNER_REVIEW_MISSING'));assert(r.bindings[0].reasons.includes('CALENDAR_EVIDENCE_MISSING'));
 assert(r.bindings[0].reasons.includes('NATIVE_ID_MISSING'));assert(r.bindings[1].reasons.includes('EDITION_REVIEW_MISSING'));assert(!r.bindingsReady);
});
for(const name of ['BLAST SLAM IX Qualifiers','BLAST SLAM IX Division 2','BLAST SLAM VIII','DreamLeague Season 30']){
 test('rejects native scope substitution: '+name,()=>{const p=fixture(),rows=JSON.parse(p.sources[0].bodyText);rows[0].name=name;
  editSource(p,'catalogue',JSON.stringify(rows));assert(!inspect(p).bindings[0].bindingReviewed);});
}
test('duplicate name with different native ID is ambiguous even with selected hyperlink',()=>{
 const p=fixture(),rows=JSON.parse(p.sources[0].bodyText);rows.push({...rows[0],leagueid:99999});editSource(p,'catalogue',JSON.stringify(rows));
 assert(inspect(p).bindings[0].reasons.includes('AMBIGUOUS_NATIVE_EDITION'));
});
test('excluded or unknown provider tier does not establish a professional native league',()=>{
 for(const tier of ['excluded',null]){const p=fixture(),rows=JSON.parse(p.sources[0].bodyText);rows[0].tier=tier;editSource(p,'catalogue',JSON.stringify(rows));
  assert(inspect(p).bindings[0].reasons.includes('NATIVE_PRO_STATUS_UNVERIFIED'));}
});
test('wrong link ID, free text URL and cross-edition section cannot establish link',()=>{
 for(const mutate of [p=>{p.bindings[0].link.href='https://www.opendota.com/leagues/90002';},
  p=>{p.bindings[0].link.section='BLAST SLAM IX 2026 '+p.bindings[0].link.href;editSource(p,'link0',p.bindings[0].link.section);},
  p=>{p.bindings[0].link.section=p.bindings[0].link.section.replace('SLAM IX','SLAM VIII');editSource(p,'link0',p.bindings[0].link.section);},
  p=>{p.bindings[0].link.section=p.bindings[0].link.section.replace('2026','2025');editSource(p,'link0',p.bindings[0].link.section);}]){
  const p=fixture();mutate(p);assert(!inspect(p).bindings[0].bindingReviewed);
 }
});
test('data-href, href inside a title and duplicate attributes are not an explicit anchor reference',()=>{
 for(const attributes of ['data-href="URL"','title=\'href="URL"\'','href="URL" href="URL"']){
  const p=fixture(),link=p.bindings[0].link;link.section='BLAST SLAM IX 2026 <a '+attributes.replaceAll('URL',link.href)+'>League</a>';
  editSource(p,'link0',link.section);assert(!inspect(p).bindings[0].bindingReviewed);
 }
});
test('edition and year require token boundaries, not prefixes of another edition/year',()=>{
 for(const [index,from,to] of [[0,'SLAM IX','SLAM IX0'],[1,'Season 30','Season 300'],[0,'2026','12026']]){
  const p=fixture(),link=p.bindings[index].link;link.section=link.section.replace(from,to);editSource(p,'link'+index,link.section);
  assert(!inspect(p).bindings[index].bindingReviewed);
 }
});
test('official-looking foreign host, credentials, secrets, redirects and fake representation rejected',()=>{
 for(const mutate of [p=>p.sources[3].url='https://blast.tv.evil.example/event',p=>p.sources[0].url+='?api_key=secret',
  p=>p.sources[0].url='https://user:secret@api.opendota.com/api/leagues',p=>p.sources[0].httpStatus=302,
  p=>p.sources[0].representation='normalized_projection',p=>p.sources[0].url='https://api.opendota.com:444/api/leagues']){
  const p=fixture();mutate(p);assert.throws(()=>inspect(p));
 }
});
test('catalogue must come from exact OpenDota endpoint and organizer from corresponding host',()=>{
 const p=fixture();p.sources[0].url='https://api.opendota.com/api/proMatches';assert(inspect(p).bindings[0].reasons.includes('NATIVE_SOURCE_ENDPOINT_MISMATCH'));
 const q=fixture();q.sources.find(s=>s.id==='link0').url='https://pro.eslgaming.com/wrong-organizer';
 assert(inspect(q).bindings[0].reasons.includes('ORGANIZER_HOST_MISMATCH'));
});
test('hash tamper, future fetch and changing policy fail closed',()=>{
 for(const mutate of [p=>p.sources[0].bodyText+=' ',p=>p.sources[0].fetchedAt='2026-11-16T00:00:00.000Z',
  p=>p.policySha256='a'.repeat(64),p=>p.reviewedAt='2026-11-16T00:00:00.000Z']){const p=fixture();mutate(p);assert.throws(()=>inspect(p));}
 assert.throws(()=>inspectTournamentBindingsV2(fixture(),policyText+' ',at));
});
test('duplicate keys, unsafe numeric IDs and duplicate IDs rejected',()=>{
 for(const body of ['[{"leagueid":90001,"leagueid":90002,"name":"BLAST SLAM IX"}]',
  '[{"leagueid":9007199254740993,"name":"BLAST SLAM IX"}]',
  JSON.stringify([{leagueid:90001,name:'BLAST SLAM IX'},{leagueid:'90001',name:'BLAST SLAM IX'}])]){
  const p=fixture();editSource(p,'catalogue',body);assert.throws(()=>inspect(p));
 }
});
test('decimal string ID above JS safe integer remains exact across catalogue and organizer link',()=>{
 const p=fixture(),id='9007199254740993',b=p.bindings[0],rows=JSON.parse(p.sources[0].bodyText);
 rows[0].leagueid=id;editSource(p,'catalogue',JSON.stringify(rows));b.link.section=b.link.section.replace('90001',id);
 b.link.href=b.link.href.replace('90001',id);b.leagueId=id;editSource(p,'link0',b.link.section);
 assert.equal(inspect(p).bindings[0].leagueId,id);
});
test('same selected ID cannot be reviewed for two different editions',()=>{
 const p=fixture();p.bindings[1].leagueId=p.bindings[0].leagueId;assert.throws(()=>inspect(p),/duplicate_selected_native_id/);
});
test('calendar source, excerpts, dates and future lower bound are checked',()=>{
 for(const mutate of [p=>p.bindings[0].calendar.periodExcerpt='not in original',p=>p.bindings[0].calendar.fromDate='2026-11-21',
  p=>p.bindings[0].calendar.startBound.at=at,p=>p.bindings[0].calendar.startBound.at='2026-11-20T01:00:00.000Z',
  p=>p.sources.find(s=>s.id==='calendar0').url='https://blast.tv/other']){const p=fixture();mutate(p);assert(!inspect(p).bindings[0].bindingReviewed);}
});
test('registration deadline equality cannot produce ready bindings',()=>{
 const p=fixture(),r=inspectTournamentBindingsV2(p,policyText,policy.proposedRegistration.decisionDeadline);
 assert(r.reasons.includes('REGISTRATION_DEADLINE_PASSED'));assert(!r.bindingsReady);
});
test('extra flags, duplicate reviews and undeclared references fail closed',()=>{
 for(const mutate of [p=>p.collectionAllowed=true,p=>p.bindings[1]=structuredClone(p.bindings[0]),
  p=>p.sources.push(structuredClone(p.sources[0])),p=>p.bindings[0].native.sourceId='absent']){const p=fixture();mutate(p);assert.throws(()=>inspect(p));}
});
test('read-only CLI checks file SHA and exclusively creates compact report; never outputs raw evidence',async()=>{
 const dir=await mkdtemp('.tools/binding-v2-test-'),path=dir+'/input.json',body=JSON.stringify(fixture());await writeFile(path,body);
 const cli='tools/research/inspect-tournament-bindings-v2.mjs',out=dir+'/report.json';
 const run=(hash=sha(body),output=out,extra=[])=>spawnSync(process.execPath,[cli,'inspect',path,hash,output,...extra],{encoding:'utf8'});
 const first=run();assert.equal(first.status,0,first.stderr);assert(!first.stdout.includes('SYNTHETIC TEST ONLY'));
 const result=JSON.parse(await readFile(out,'utf8'));assert.equal(result.report.registrationReady,false);assert(!JSON.stringify(result).includes('bodyText'));
 assert.equal(run().status,1);assert.equal(run('f'.repeat(64),dir+'/wrong.json').status,1);
 const invalid=run(sha(body),dir+'/flags.json',['--register']);assert.equal(invalid.status,1);assert(!invalid.stderr.includes(path));
});
