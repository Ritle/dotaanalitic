/** Fixed first TI2023 map: archived Steam32 associations, never an automatic identity/lineup import. */
import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ArchiveEvidenceClient,ValvePatchError,MapAccountObservationSchema,teamAccountOriginal,
  verifyArchivedTeamAccounts,auditHistoricalMapAccounts} from '../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
const path=args.length===2&&args[0]==='--out'?resolve(root,args[1]):null,rel=path?relative(root,path):null;
if(!rel||isAbsolute(rel)||rel.startsWith('..')||!rel.endsWith('.json')){
  console.error('Использование: audit-account-evidence.mjs --out reports/new-account-evidence.json внутри проекта.');process.exit(2);
}
const hash=b=>createHash('sha256').update(b).digest('hex');
try{
  try{await stat(path);console.error('Файл отчёта уже существует. Укажите новое имя.');process.exit(2);}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const mapFile='docs/evidence/s3-01-ti12-map-accounts.json',mapBytes=await readFile(resolve(root,mapFile));
  const raw=JSON.parse(mapBytes),map=MapAccountObservationSchema.parse(raw);
  const selectionFile='docs/evidence/s3-01-ti12-registration.json',selectionBytes=await readFile(resolve(root,selectionFile));
  const priorManifest=JSON.parse(await readFile(resolve(root,'docs/evidence/s3-01-ti12-registration.manifest.json'),'utf8'));
  if(hash(selectionBytes)!==priorManifest.sha256||hash(selectionBytes)!==raw.selectionEvidence?.sha256||
    raw.selectionEvidence?.file!==selectionFile)throw new Error('selection_hash_mismatch');
  const prior=JSON.parse(selectionBytes).retrospectiveLookupSelection;
  if(map.matchId!==prior.matchId||map.startedAt!==prior.startedAt||map.leagueId!==prior.leagueId||
    raw.teamIds?.radiant!==prior.radiantTeamId||raw.teamIds?.dire!==prior.direTeamId)throw new Error('selection_mismatch');
  const teamIds=[raw.teamIds.radiant,raw.teamIds.dire];
  if(new Set(teamIds).size!==2)throw new Error('duplicate_team');teamIds.forEach(teamAccountOriginal);
  const client=new ArchiveEvidenceClient(),sources=[],lookups=[],proofs=[],errors=[];
  for(const teamId of teamIds){
    try{
      const index=await client.findTeamAccountsBefore(teamId,map.startedAt);sources.push(index.source);
      lookups.push({teamId,original:teamAccountOriginal(teamId),records:index.records,
        status:index.records.length?'indexed_snapshot_found':'no_snapshot_in_this_exact_query'});
      if(index.records.length){
        const selected=index.records[0],snapshot=await client.getTeamAccountsSnapshot(teamId,selected.timestamp);sources.push(snapshot.source);
        proofs.push(verifyArchivedTeamAccounts({...snapshot,digest:selected.digest,fetchedAt:snapshot.source.fetchedAt},teamId));
      }
    }catch(error){errors.push({teamId,code:error instanceof ValvePatchError?error.code:'team_account_verification_failed',
      status:error instanceof ValvePatchError?error.status:null});}
  }
  const generatedAt=new Date().toISOString(),coverage=auditHistoricalMapAccounts(proofs,map,generatedAt);
  const files=['scripts/audit-account-evidence.mjs','packages/ingestion/src/valve/team-account-evidence.ts',
    'packages/ingestion/src/valve/archive-client.ts','packages/ingestion/src/valve/archive-evidence.ts',
    'packages/contracts/src/identity.ts','packages/ingestion/dist/valve/team-account-evidence.js',
    'packages/ingestion/dist/valve/archive-client.js','pnpm-lock.yaml'];
  const code=await Promise.all(files.map(async file=>({file,sha256:hash(await readFile(resolve(root,file)))})));
  const report={schemaVersion:1,mode:'live_archived_team_account_associations',generatedAt,
    captureStatus:errors.length?'partial_or_blocked':proofs.length===2?'complete':'incomplete_archive_coverage',
    selectionPolicy:'first_existing_TI2023_map_native_teams_earliest_returned_archive_before_start_no_year_lower_bound_limit_5',
    mapObservation:{file:mapFile,sha256:hash(mapBytes)},sources,lookups,proofs,coverage,code,requests:client.requestStats,errors,
    scope:'source_account_alias_associations_only',databaseWrites:0,canonicalPlayersCreated:0,verifiedMapLineups:0,
    strictDatasetStatus:'unavailable',trainingExamples:0,trainingReady:false,deployable:false};
  const content=JSON.stringify(report,null,2)+'\n';await mkdir(dirname(path),{recursive:true});await writeFile(path,content,{flag:'wx'});
  console.log(JSON.stringify({file:rel.replaceAll('\\','/'),sha256:hash(content),captureStatus:report.captureStatus,
    accountsObservedBeforeCutoff:coverage.accountsObservedBeforeCutoff,knownMapAccounts:coverage.knownMapAccounts,
    canonicalPlayersCreated:0,verifiedMapLineups:0,trainingExamples:0,requests:report.requests,errors}));
  if(errors.length||proofs.length!==2)process.exitCode=3;
}catch{console.error('Аудит account evidence не выполнен. Проверьте исходные captures, сборку и новый путь отчёта.');process.exitCode=1;}
