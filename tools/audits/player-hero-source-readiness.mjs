/** Bounded source inventory, no provider calls, fitting, registry writes or publication. */
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {z}=createRequire(new URL('../../packages/contracts/package.json',import.meta.url))('zod');
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const Id=z.union([z.number().int().positive().safe(),z.string().regex(/^[1-9]\d{0,18}$/)])
  .transform(String).refine(id=>BigInt(id)<=9223372036854775807n);
const Account=Id.refine(id=>BigInt(id)<4294967295n);
const Int=z.number().int().safe();
const Player=z.object({steamAccountId:Account.nullable(),heroId:Int.nonnegative().nullable(),
  playerSlot:Int.nullable(),isRadiant:z.boolean().nullable()});
const Live=z.object({matchId:Id,leagueId:Int.positive().nullable(),radiantTeamId:Id.nullable(),direTeamId:Id.nullable(),
  gameState:z.string().min(1).max(64).nullable(),gameTime:Int.nullable(),delay:Int.nonnegative().nullable(),
  createdDateTime:Int.nonnegative().nullable(),modifiedDateTime:Int.nonnegative().nullable(),players:z.array(Player).max(10).nullable()});
export function inspectLiveDraft(raw){
  const m=Live.parse(raw),players=m.players??[],reasons=[];
  const slots=[0,1,2,3,4,128,129,130,131,132];
  if(players.length!==10||players.some(p=>p.steamAccountId===null)||new Set(players.map(p=>p.steamAccountId)).size!==10)reasons.push('TEN_DISTINCT_ACCOUNTS_MISSING');
  if(players.length!==10||players.some(p=>p.heroId===null||p.heroId<=0)||new Set(players.map(p=>p.heroId)).size!==10)reasons.push('TEN_DISTINCT_HEROES_MISSING');
  if(players.length!==10||new Set(players.map(p=>p.playerSlot)).size!==10||players.some(p=>!slots.includes(p.playerSlot)||p.isRadiant!==(p.playerSlot<128)))reasons.push('MAP_SIDES_UNVERIFIED');
  if(!['STRATEGY_TIME','PRE_GAME'].includes(m.gameState))reasons.push('FINAL_PREGAME_DRAFT_NOT_OBSERVED');
  if(m.radiantTeamId===null||m.direTeamId===null||m.radiantTeamId===m.direTeamId)reasons.push('TEAM_IDENTIFIERS_MISSING');
  return {matchId:m.matchId,leagueId:m.leagueId,gameState:m.gameState,gameTime:m.gameTime,delay:m.delay,
    playersObserved:players.length,candidateDraftObservation:reasons.length===0,reasons,
    warnings:['PRO_MAP_STATUS_REQUIRES_SEPARATE_VERIFICATION','LIVE_DELAY_AND_PHASE_SEMANTICS_UNVERIFIED',
      'FETCH_MINUS_GAME_TIME_IS_NOT_VERIFIED_ACTUAL_START','CANONICAL_IDENTITY_LINKS_NOT_VERIFIED'],
    actualGameplayStartedAt:null,prestartVerified:false,primaryEligible:false,deployable:false};
}

export function compareHistoricalStart(raw){
  const x=z.object({matchId:Id,openDotaStartUs:z.string().regex(/^[1-9]\d{0,18}$/),
    stratzStartSeconds:Int.positive(),stratzFetchedAt:z.iso.datetime({precision:3}),stratzKnownAt:z.iso.datetime({precision:3}).nullable()}).strict().parse(raw);
  return {...x,startsAgree:BigInt(x.openDotaStartUs)===BigInt(x.stratzStartSeconds)*1000000n,
    receiptBeforeProviderStart:Date.parse(x.stratzFetchedAt)<x.stratzStartSeconds*1000,
    clockSemanticsVerified:false,prestartDraftAvailabilityVerified:false,
    warning:'AGREEING_POSTGAME_TIMESTAMPS_DO_NOT_ESTABLISH_DRAFT_TO_GAMEPLAY_BOUNDARY'};
}
const sampleIds=['9070527945','9068910292','9067177642'];
const outputPath='.tools/s304-source-readiness-report-r1.json';
async function report(){
 const sources={};
 async function read(path){const f=resolve(root,path);assert((await stat(f)).size<128*1024*1024);
   const bytes=await readFile(f);sources[path]=sha(bytes);return JSON.parse(bytes);}
 const inventory=await read('.tools/s304-source-readiness-inventory-r1.json');assert.equal(inventory.clock.read_only,'on');
 const historical=await read('.tools/s304-dataset-capture-final.json');
 const comparisons=[];
 for(const id of sampleIds){
   const prefix='.tools/stratz-owner-pilot-20261102/match-'+id;
   const receipt=await read(prefix+'.json'),body=await read(prefix+'.body');assert.equal(receipt.status,200);assert.equal(receipt.sha256,sources[prefix+'.body']);
   const m=body.data.match,old=historical.source.candidates.find(m=>m.matchId===id);assert(old&&old.isPro===true&&old.outcome.status==='verified');
   assert.equal(String(m.id),id);assert(Array.isArray(m.players)&&m.players.length===10);
   const accounts=m.players.map(p=>Account.parse(p.steamAccountId)).sort();
   assert.equal(new Set(accounts).size,10);
   assert.deepEqual(accounts,old.players.map(p=>String(p.sourceAccountId)).sort());
   assert.equal(new Set(m.players.map(p=>p.heroId)).size,10);assert(m.players.every(p=>Number.isInteger(p.heroId)&&p.heroId>0));
   comparisons.push({...compareHistoricalStart({matchId:id,openDotaStartUs:old.startedAtUs,stratzStartSeconds:m.startDateTime,
     stratzFetchedAt:receipt.fetchedAt,stratzKnownAt:receipt.knownAt}),players:10,distinctAccounts:10,distinctHeroes:10,
     picks:m.pickBans.filter(p=>p.isPick).length,verifiedOpenDotaOutcome:true});
 }
 const probe=await read('.tools/s304-source-readiness-live-r1.json');let live=[];
 if(probe.result==='captured_for_validation'){
   const body=await read('.tools/s304-source-readiness-live-r1.body');assert.equal(probe.sha256,sources['.tools/s304-source-readiness-live-r1.body']);
   assert(!body.errors?.length&&Array.isArray(body.data?.live?.matches)&&body.data.live.matches.length<=5);
   live=body.data.live.matches.map(inspectLiveDraft);
 }
 const schema=await read('.tools/stratz-review-20261102/schema.body');
 const schemaReceipt=await read('.tools/stratz-review-20261102/schema.json');
 assert.equal(schemaReceipt.sha256,sources['.tools/stratz-review-20261102/schema.body']);
 const types=schema.data.__schema.types;
 const fields=name=>types.find(t=>t.name===name)?.fields?.map(f=>f.name)??[];
 const sourceCode=['packages/db/src/scenario-repository.ts','packages/contracts/src/scenario.ts','apps/web/src/views/ScenariosView.vue',
   'packages/db/migrations/015_scenario_snapshots.sql','packages/db/migrations/016_scenario_draft.sql',
   'packages/db/src/schedule-page-binding.ts','packages/ingestion/src/pandascore/schemas.ts',
   'tools/audits/player-hero-source-readiness.mjs','tests/node/player-hero-source-readiness.test.mjs'];
 for(const path of sourceCode)sources[path]=sha(await readFile(resolve(root,path)));
 return {format:'player-hero-source-readiness-audit-v1',node:process.version,sources,
   scope:'local_scenario_inventory_three_cached_historical_maps_one_bounded_live_probe',
   local:{snapshots:inventory.snapshots,fullDraftRevisionsObserved:inventory.drafts.length,
     distinctFullDraftScenarios:new Set(inventory.drafts.map(r=>r.scenario_id)).size,
     exactMicrosRecordedAtAvailable:true,immutableScenarioTrigger:inventory.triggers.some(t=>t.tgname==='scenario_snapshot_guard'),
     frozenAccountBindingsInScenario:false,serverDecisionCutoffInScenario:false,durableDraftMapBinding:false},
   historicalComparisons:comparisons,
   schema:{fetchedAt:schemaReceipt.fetchedAt,liveQueryFields:fields('LiveQuery'),liveFields:fields('MatchLiveType').filter(n=>['matchId','gameState','gameTime','delay','players','createdDateTime','modifiedDateTime'].includes(n)),
     startDateTimeDescription:types.find(t=>t.name==='MatchType').fields.find(f=>f.name==='startDateTime').description},
   live:{attempts:probe.attempts,status:probe.status??null,result:probe.result??probe.error,returnedMaps:probe.returnedMaps??null,
     observations:live,coverage:live.length?'bounded_observation_only':'not_demonstrated_no_live_sample',prestartVerifiedMaps:0},
   blockers:['TRUSTED_COMPLETE_INPUT_CAPTURE_NOT_IMPLEMENTED','DECISION_CUTOFF_MUST_BE_SERVER_GENERATED',
     'MAP_OR_PENDING_SERIES_SLOT_BINDING_NOT_PERSISTED','FINAL_INPUT_MATCH_TO_ACTUAL_ACCOUNTS_HEROES_NOT_VERIFIED',
     'ACTUAL_GAMEPLAY_START_CLOCK_SEMANTICS_UNVERIFIED','PREDICTION_PERSISTENCE_NOT_IMPLEMENTED_FOR_H1_H2'],
   nextTask:'S3-04/player-hero-owner-capture',manualDraftAllowed:true,automaticDraftRequired:false,
   registrationAllowed:false,collectionAllowed:false,trainingPerformed:false,scoringPerformed:false,deployable:false};
}
async function main(){
 const [mode,expected]=process.argv.slice(2);assert(['prepare','verify'].includes(mode));
 if(mode==='verify'){assert(/^[a-f0-9]{64}$/.test(expected??''));assert.equal(sha(await readFile(resolve(root,outputPath))),expected);}
 const result=await report(),bytes=JSON.stringify(result,null,2)+'\n';
 if(mode==='verify')assert.equal(await readFile(resolve(root,outputPath),'utf8'),bytes,'source_readiness_replay_changed');
 else await writeFile(resolve(root,outputPath),bytes,{flag:'wx'});
 console.log(JSON.stringify({status:mode==='verify'?'verified':'saved',sha256:sha(bytes),historicalMaps:result.historicalComparisons.length,
   liveMaps:result.live.returnedMaps,registrationAllowed:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
 console.error('Проверка источников отклонена: проверьте файлы, схемы и SHA. Перезапись запрещена.');process.exitCode=1;
});
