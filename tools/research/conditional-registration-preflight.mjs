/** Read-only source diagnostic. Candidates are not verified edition bindings or registration. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,realpath,stat,mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {LeaguesSchema} from '../../packages/ingestion/dist/opendota/schemas.js';
import {registrationDigest} from './conditional-registration.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const policyPath='tools/research/player-hero-conditional-future-policy.json';
const expectedPolicySha='77fa352544f4938e8b1cd69a2772894cff6b34df4b954e97677d36ea10ce388f';
export const preflightSha=b=>createHash('sha256').update(b).digest('hex');
const Time=z.string().datetime({precision:3}),Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n),Label=z.string().max(256).nullable();
const Source=z.object({provider:z.string(),endpoint:z.string().max(512),fetchedAt:Time,knownAt:z.null(),payloadSha256:Hash});
const Row=z.object({providerMatchId:Id,name:Label,status:z.string().max(40),scheduledAt:Time.nullable(),
 tournament:z.object({providerTournamentId:Id,name:Label}),league:z.object({providerLeagueId:Id,name:Label}),
 eventSeries:z.object({providerEventSeriesId:Id,name:Label}).nullable(),seriesBestOf:z.number().nullable(),
 opponents:z.array(z.object({providerTeamId:Id,name:Label})).max(2)});
const Observation=z.object({data:z.array(Row).max(20),source:Source});
const Catalogue=z.object({data:LeaguesSchema,rawBody:z.string().max(16777216),source:Source});
const Input=z.object({checkedAt:Time,catalogue:Catalogue.nullable(),pages:z.array(z.object({page:z.number().int().min(1).max(50),observation:Observation}).strict()).max(50)}).strict();
const normalize=s=>(s??'').trim().replace(/\s+/g,' ').toLowerCase();
const excluded=s=>/qualif|division\s*2/i.test(s??'');
const unique=values=>[...new Set(values)];

export function inspectConditionalRegistrationPreflight(raw,policy){
 const input=Input.parse(raw),{checkedAt,catalogue,pages}=input;
 const events=policy.proposedRegistration.events;
 assert(events.length===2&&events[0].name==='BLAST SLAM IX'&&events[1].name==='DreamLeague Season 30','unsupported_proposed_scope');
 if(catalogue){
  assert.equal(catalogue.source.provider,'opendota');assert.equal(catalogue.source.endpoint,'/leagues');
  assert(catalogue.source.fetchedAt<=checkedAt,'future_catalogue');
  assert.equal(preflightSha(catalogue.rawBody),catalogue.source.payloadSha256,'catalogue_raw_hash');
  const parsed=LeaguesSchema.parse(JSON.parse(catalogue.rawBody));
  assert.equal(registrationDigest(parsed),registrationDigest(catalogue.data),'catalogue_projection_changed');
  assert.equal(new Set(parsed.map(r=>r.leagueid)).size,parsed.length,'duplicate_catalogue_id');
 }
 const rows=[],ids=new Set();let ended=false;
 for(const [i,page] of pages.entries()){
  assert.equal(page.page,i+1,'noncontiguous_pages');assert(!ended,'page_after_observed_end');
  const observation=page.observation;
  assert.equal(observation.source.provider,'pandascore');
  assert.equal(observation.source.endpoint,`/dota2/matches/upcoming?sort=scheduled_at,id&page=${page.page}&per_page=20`,'wrong_page_endpoint');
  assert(observation.source.fetchedAt<=checkedAt,'future_page');
  for(const row of observation.data){assert(!ids.has(row.providerMatchId),'page_drift_duplicate_match');ids.add(row.providerMatchId);rows.push(row);}
  ended=observation.data.length<20;
 }
 const scan=pages.length===0?'unavailable':ended?'endpoint_end_observed':'partial';
 const scope=events.map(event=>{
  const isBlast=event.name==='BLAST SLAM IX';
  const relatedText=s=>isBlast?/blast.*\b(?:IX|9)\b/i.test(s??''):/dreamleague.*(?:\b30\b|division\s*2)/i.test(s??'');
  const relatedCatalogue=(catalogue?.data??[]).filter(r=>relatedText(r.name));
  const candidates=relatedCatalogue.filter(r=>normalize(r.name)===normalize(event.name)&&!excluded(r.name));
  const relatedRows=rows.filter(r=>relatedText([r.league.name,r.eventSeries?.name,r.tournament.name].join(' ')));
  const listed=relatedRows.filter(r=>!excluded([r.league.name,r.eventSeries?.name,r.tournament.name].join(' ')));
  const times=listed.flatMap(r=>r.scheduledAt?[r.scheduledAt]:[]).sort();
  return {name:event.name,stage:'main_event',calendar:{fromDate:event.fromDate,throughDate:event.throughDate,source:event.source},
   openDota:{status:catalogue?(candidates.length?'candidate_records_observed':'not_observed_in_catalogue'):'unknown_source_unavailable',
    candidates:candidates.map(r=>({leagueId:r.leagueid,name:r.name,tier:r.tier??null})),
    excludedRelated:relatedCatalogue.filter(r=>excluded(r.name)).map(r=>({leagueId:r.leagueid,name:r.name})),
    bindingVerified:false,fetchedAt:catalogue?.source.fetchedAt??null},
   pandaScore:{status:listed.length?'candidate_rows_observed':scan==='endpoint_end_observed'?'not_observed_in_scan':'unknown_partial_or_unavailable_scan',
    matchIds:listed.map(r=>r.providerMatchId),tournamentIds:unique(listed.map(r=>r.tournament.providerTournamentId)),
    eventSeriesIds:unique(listed.flatMap(r=>r.eventSeries?[r.eventSeries.providerEventSeriesId]:[])),
    excludedRelatedMatches:relatedRows.length-listed.length,firstListedSeriesAt:times[0]??null,bindingVerified:false},
   verifiedNativeLeagueId:null,verifiedStageTournamentIds:[],earliestVerifiedSeriesAt:null};
 });
 const deadlinePassed=checkedAt>=policy.proposedRegistration.decisionDeadline;
 return {format:'conditional-registration-preflight-v1',checkedAt,scope,
  schedule:{scan,pages:pages.length,rows:rows.length,duplicateMatchIds:0,atomicSnapshot:false,futureDenominatorComplete:false,
   retainedRepresentation:'normalized_provider_observations',fetchedAt:pages.map(p=>p.observation.source.fetchedAt)},
  proposedWindow:{decisionDeadline:policy.proposedRegistration.decisionDeadline,from:policy.proposedRegistration.from,
   until:policy.proposedRegistration.until,assessmentAt:policy.proposedRegistration.assessmentAt},
  registrationBlockers:[...(deadlinePassed?['REGISTRATION_DECISION_DEADLINE_PASSED']:[]),
   'MAIN_EVENT_NATIVE_BINDINGS_NOT_VERIFIED','TARGET_START_BOUND_NOT_VERIFIED',
   'REAL_REGISTRATION_CONSUMER_NOT_IMPLEMENTED','SQL062_REJECTS_REAL_REGISTRATION',
   'REAL_CONSUMER_EXECUTABLE_ENVIRONMENT_MANIFEST_NOT_FROZEN'],
  assessmentRequirements:['FULL_ACTUAL_MAP_AND_SERIES_DENOMINATOR','VERIFIED_SEPARATE_OUTCOMES','WHOLE_SERIES_EXPOSURE_EXCLUSION',
   'INDEPENDENT_SAMPLE_COVERAGE_AND_METRIC_GATES'],
  status:'blocked',registrationPlan:null,registrationReady:false,registrationPerformed:false,
  collectionAllowed:false,realEvaluationAllowed:false,activationAllowed:false,deployable:false};
}

async function bounded(path){const s=await stat(path);assert(s.isFile()&&s.size<=16*1024*1024,'bounded_file_required');return readFile(path);}
async function privatePath(path,allowRoot=false){
 const full=await realpath(resolve(root,path)),base=await realpath(join(root,'.tools')),r=relative(base,full);
 assert((allowRoot||r)&&!r.startsWith('..')&&!r.includes(':'),'private_path_required');return full;
}
const Ref=z.object({name:z.string().regex(/^[a-z0-9-]+$/),path:z.string().max(512),sha256:Hash}).strict();
const Manifest=z.object({format:z.literal('conditional-preflight-source-manifest-v1'),createdAt:Time,refs:z.array(Ref).min(1).max(60)}).strict();

export async function loadPreflightSources(manifestPath,expectedSha){
 Hash.parse(expectedSha);const manifestBytes=await bounded(await privatePath(manifestPath));
 assert.equal(preflightSha(manifestBytes),expectedSha,'source_manifest_hash');const manifest=Manifest.parse(JSON.parse(manifestBytes));
 assert.equal(new Set(manifest.refs.map(r=>r.name)).size,manifest.refs.length,'duplicate_source_ref');
 const loaded={};
 for(const ref of manifest.refs){const b=await bounded(await privatePath(ref.path));assert.equal(preflightSha(b),ref.sha256,'source_hash:'+ref.name);loaded[ref.name]=JSON.parse(b);}
 const pages=Object.entries(loaded).filter(([name])=>/^pandascore-page-\d+$/.test(name)).map(([name,observation])=>({page:Number(name.slice('pandascore-page-'.length)),observation})).sort((a,b)=>a.page-b.page);
 return {manifest,loaded,input:{checkedAt:manifest.createdAt,catalogue:loaded['opendota-catalogue']??null,pages}};
}

async function main(){
 const [mode,path,expectedSha,output]=process.argv.slice(2);
 assert(mode==='inspect'&&path&&expectedSha&&output&&process.argv.length===6,'usage_inspect_source_manifest_sha_output_directory');
 const policyBytes=await readFile(join(root,policyPath));assert.equal(preflightSha(policyBytes),expectedPolicySha,'policy_changed');
 const policy=JSON.parse(policyBytes),source=await loadPreflightSources(path,expectedSha),report=inspectConditionalRegistrationPreflight(source.input,policy);
 const parent=await privatePath(dirname(resolve(root,output)),true),directory=join(parent,resolve(root,output).slice(dirname(resolve(root,output)).length+1));
 await mkdir(directory);
 const reportText=JSON.stringify({...report,sourceManifest:{path,sha256:expectedSha},policySha256:expectedPolicySha},null,2)+'\n';
 await writeFile(join(directory,'report.json'),reportText,{flag:'wx'});
 console.log(JSON.stringify({status:report.status,scope:report.scope,schedule:report.schedule,reportSha256:preflightSha(reportText),directory:relative(root,directory),registrationPerformed:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(()=>{console.error(JSON.stringify({status:'unavailable',reason:'preflight_invalid_input_or_output',registrationPerformed:false}));process.exitCode=1;});
}
