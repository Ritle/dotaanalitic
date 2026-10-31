/** Bounded read-only capture: tournament registration is distinct from pre-start map attendance. */
import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ArchiveEvidenceClient,ValvePatchError,IdentityLedgerSnapshotSchema,verifyArchivedLeagueRosters,
  verifyValveMapParticipants,auditLeagueLineupEvidence,auditHistoricalMapAccounts} from '../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),hash=b=>createHash('sha256').update(b).digest('hex');
const path=args.length===2&&args[0]==='--out'?resolve(root,args[1]):null,rel=path?relative(root,path):null;
if(!rel||isAbsolute(rel)||rel.startsWith('..')||!rel.endsWith('.json')){
  console.error('Использование: audit-lineup-evidence.mjs --out reports/new-lineup-evidence.json внутри проекта.');process.exit(2);
}
try{
  try{await stat(path);console.error('Файл отчёта уже существует. Укажите новое имя.');process.exit(2);}catch(e){if(e.code!=='ENOENT')throw e;}
  const mapFile='docs/evidence/s3-01-ti12-map-accounts.json',appliedFile='docs/evidence/s3-01-ti12-identity-applied.json';
  const manifestFile='docs/evidence/s3-01-ti12-identity-provision.manifest.json';
  const [mapBytes,appliedBytes,manifestBytes]=await Promise.all([mapFile,appliedFile,manifestFile].map(f=>readFile(resolve(root,f))));
  const map=JSON.parse(mapBytes),applied=JSON.parse(appliedBytes),manifest=JSON.parse(manifestBytes);
  const ledger=IdentityLedgerSnapshotSchema.parse(applied.identityLedger),mapObservation={file:mapFile,sha256:hash(mapBytes)};
  if(manifest.applied?.file!==appliedFile||manifest.applied.sha256!==hash(appliedBytes)||
    applied.identityLedger.mapObservation?.file!==mapFile||applied.identityLedger.mapObservation.sha256!==mapObservation.sha256)
    throw new Error('lineup_input_hash');
  const base=auditHistoricalMapAccounts([],map,new Date().toISOString()),leagueId='15728',teamIds=['8291895','8260983'];
  // This diagnostic retains the previously selected map; outcomes never enter selection or the projection.
  if(base.matchId!=='7378530387'||map.leagueId!==leagueId||base.startedAt!=='2023-10-12T17:00:44.000Z')throw new Error('lineup_fixed_selection');
  const ids=base.players.flatMap(p=>p.accountId===null?[]:[p.accountId]);
  if(ids.length!==10||JSON.stringify([...ids].sort())!==JSON.stringify([...ledger.accountIds].sort())||ledger.observedAt>new Date().toISOString())
    throw new Error('lineup_ledger_selection');
  const client=new ArchiveEvidenceClient(),sources=[],errors=[];let lookup=null,registration=null,actual=null,review=null;
  try{
    const index=await client.findTi12LeagueBefore(base.startedAt);sources.push(index.source);lookup=index.records;
    // Latest returned capture in this bounded exact-URL query, chosen before examining its contents.
    const selected=index.records.at(-1);
    if(selected){const s=await client.getLeagueRosterSnapshot(leagueId,selected.timestamp);sources.push(s.source);
      registration=verifyArchivedLeagueRosters({...s,digest:selected.digest,fetchedAt:s.source.fetchedAt},leagueId,teamIds,base.matchId);}
    const current=await client.getCurrentLeagueMap(leagueId,base.matchId);sources.push(current.source);
    actual=verifyValveMapParticipants({...current,fetchedAt:current.source.fetchedAt,sourceUrl:current.source.url},leagueId,base.matchId);
  }catch(e){errors.push({code:e instanceof ValvePatchError?e.code:'lineup_source_verification_failed',status:e instanceof ValvePatchError?e.status:null});}
  const generatedAt=new Date().toISOString();
  if(registration&&actual){try{review=auditLeagueLineupEvidence(registration,actual,map,ledger,generatedAt);}
    catch{errors.push({code:'lineup_evidence_binding_failed',status:null});}}
  const files=['scripts/audit-lineup-evidence.mjs','packages/ingestion/src/valve/league-lineup-evidence.ts',
    'packages/ingestion/src/valve/archive-client.ts','packages/ingestion/src/valve/archive-evidence.ts',
    'packages/ingestion/src/valve/team-account-evidence.ts','packages/ingestion/src/opendota/registry-evidence.ts',
    'packages/db/src/identity.ts','packages/contracts/src/identity.ts',
    'packages/ingestion/dist/valve/league-lineup-evidence.js','packages/ingestion/dist/valve/archive-client.js',
    'packages/ingestion/dist/valve/archive-evidence.js','packages/ingestion/dist/valve/team-account-evidence.js',
    'packages/ingestion/dist/opendota/registry-evidence.js','packages/db/dist/identity.js','packages/contracts/dist/identity.js','pnpm-lock.yaml'];
  const code=await Promise.all(files.map(async file=>({file,sha256:hash(await readFile(resolve(root,file)))})));
  const report={schemaVersion:1,mode:'live_league_registration_and_retrospective_participants',generatedAt,
    captureStatus:errors.length?'partial_or_blocked':review?'complete':'partial_archive_coverage',
    mapObservation,identityLedger:{file:appliedFile,jsonPointer:'/identityLedger',sha256:hash(appliedBytes),observedAt:ledger.observedAt,registryRevision:ledger.registryRevision},
    previousEvidenceManifest:{file:manifestFile,sha256:hash(manifestBytes)},sources,lookup,registration,actual,review,code,requests:client.requestStats,errors,
    scope:'tournament_registration_and_retrospective_map_participation',databaseWrites:0,canonicalPlayersCreated:0,verifiedMapLineups:0,
    trainingExamples:0,strictDatasetStatus:'unavailable',trainingReady:false,deployable:false};
  const content=JSON.stringify(report,null,2)+'\n';await mkdir(dirname(path),{recursive:true});await writeFile(path,content,{flag:'wx'});
  console.log(JSON.stringify({file:rel.replaceAll('\\','/'),sha256:hash(content),captureStatus:report.captureStatus,
    registeredBeforeCutoff:review?.registeredBeforeCutoff??null,canonicalParticipants:review?.canonicalParticipants??null,
    providerAgreementRows:review?.providerAgreementRows??null,verifiedMapLineups:0,trainingExamples:0,requests:report.requests,errors}));
  if(report.captureStatus!=='complete')process.exitCode=3;
}catch{console.error('Аудит составов не выполнен. Проверьте сохранённую карту, снимок связей, SHA, сборку и новый путь отчёта.');process.exitCode=1;}
