/** Fixed saved lookup plan; profile aliases are self-published, never canonical-person evidence. */
import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ArchiveEvidenceClient,ValvePatchError,ProfileLookupPlanSchema,steamProfileLocation,
  verifyArchivedSteamProfile,auditHistoricalAccountSources} from '../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),hash=b=>createHash('sha256').update(b).digest('hex');
const path=args.length===2&&args[0]==='--out'?resolve(root,args[1]):null,rel=path?relative(root,path):null;
if(!rel||isAbsolute(rel)||rel.startsWith('..')||!rel.endsWith('.json')){
  console.error('Использование: audit-profile-evidence.mjs --out reports/new-profile-evidence.json внутри проекта.');process.exit(2);
}
try{
  try{await stat(path);console.error('Файл отчёта уже существует. Укажите новое имя.');process.exit(2);}catch(e){if(e.code!=='ENOENT')throw e;}
  const planFile='docs/evidence/s3-01-ti12-profile-lookup-plan.json',planBytes=await readFile(resolve(root,planFile));
  const plan=ProfileLookupPlanSchema.parse(JSON.parse(planBytes)),previousBytes=await readFile(resolve(root,plan.previousEvidence.file));
  const manifest=JSON.parse(await readFile(resolve(root,'docs/evidence/s3-01-ti12-account-evidence.manifest.json')));
  if(hash(previousBytes)!==plan.previousEvidence.sha256||hash(previousBytes)!==manifest.report.sha256)throw new Error('previous_evidence_hash');
  const previous=JSON.parse(previousBytes),mapBytes=await readFile(resolve(root,previous.mapObservation.file)),map=JSON.parse(mapBytes);
  if(hash(mapBytes)!==previous.mapObservation.sha256)throw new Error('map_observation_hash');
  const missing=previous.coverage.players.filter(p=>p.accountEvidenceStatus==='no_matching_archive').map(p=>p.accountId).sort();
  if(JSON.stringify(plan.targets.map(t=>t.accountId).sort())!==JSON.stringify(missing))throw new Error('target_selection_mismatch');
  plan.targets.forEach(t=>steamProfileLocation(t.original,t.accountId));
  // Four exact indexes plus at most four snapshots. Existing archive clients retain their default budget of six.
  const client=new ArchiveEvidenceClient({maxRequests:8}),sources=[],lookups=[],proofs=[],errors=[];
  for(const target of plan.targets){try{
    const index=await client.findSteamProfileBefore(target.accountId,target.original,map.startedAt);sources.push(index.source);
    lookups.push({...target,records:index.records,status:index.records.length?'indexed_snapshot_found':'no_snapshot_in_this_exact_query'});
    if(index.records.length){const selected=index.records[0];
      const s=await client.getSteamProfileSnapshot(target.accountId,selected.original,selected.timestamp);sources.push(s.source);
      proofs.push(verifyArchivedSteamProfile({...s,digest:selected.digest,fetchedAt:s.source.fetchedAt},target.accountId));}
  }catch(e){errors.push({accountId:target.accountId,code:e instanceof ValvePatchError?e.code:'profile_verification_failed',
    status:e instanceof ValvePatchError?e.status:null});}}
  const generatedAt=new Date().toISOString(),coverage=auditHistoricalAccountSources(previous.proofs,proofs,map,generatedAt);
  const files=['scripts/audit-profile-evidence.mjs','packages/ingestion/src/valve/steam-profile-evidence.ts',
    'packages/ingestion/src/valve/team-account-evidence.ts','packages/ingestion/src/valve/archive-client.ts',
    'packages/ingestion/src/valve/archive-evidence.ts','packages/contracts/src/identity.ts',
    'packages/ingestion/dist/valve/steam-profile-evidence.js','packages/ingestion/dist/valve/archive-client.js','pnpm-lock.yaml'];
  const code=await Promise.all(files.map(async file=>({file,sha256:hash(await readFile(resolve(root,file)))})));
  const report={schemaVersion:1,mode:'live_archived_steam_profile_observations',generatedAt,
    captureStatus:errors.length?'partial_or_blocked':proofs.length===plan.targets.length?'complete':'partial_archive_coverage',
    lookupPlan:{file:planFile,sha256:hash(planBytes)},previousEvidence:plan.previousEvidence,mapObservation:previous.mapObservation,
    sources,lookups,proofs,coverage,code,requests:client.requestStats,errors,scope:'source_account_observations_not_canonical_identity',
    databaseWrites:0,canonicalPlayersCreated:0,verifiedMapLineups:0,trainingExamples:0,strictDatasetStatus:'unavailable',trainingReady:false,deployable:false};
  const content=JSON.stringify(report,null,2)+'\n';await mkdir(dirname(path),{recursive:true});await writeFile(path,content,{flag:'wx'});
  console.log(JSON.stringify({file:rel.replaceAll('\\','/'),sha256:hash(content),captureStatus:report.captureStatus,
    profileProofs:proofs.length,observedAccounts:coverage.accountsObservedBeforeCutoff,knownMapAccounts:coverage.knownMapAccounts,
    trainingExamples:0,requests:report.requests,errors}));
  if(errors.length||proofs.length!==plan.targets.length)process.exitCode=3;
}catch{console.error('Аудит профилей не выполнен. Проверьте сохранённый план, исходные SHA, сборку и новый путь отчёта.');process.exitCode=1;}
