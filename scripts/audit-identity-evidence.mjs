/** Bounded archive capture + frozen, read-only ledger review; no identity creation or DB connection. */
import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ArchiveEvidenceClient,ValvePatchError,IdentityLedgerSnapshotSchema,verifyArchivedProRegistry,
  assessRegistryIdentityEvidence,auditHistoricalMapAccounts} from '../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),hash=b=>createHash('sha256').update(b).digest('hex');
const path=args.length===2&&args[0]==='--out'?resolve(root,args[1]):null,rel=path?relative(root,path):null;
if(!rel||isAbsolute(rel)||rel.startsWith('..')||!rel.endsWith('.json')){
  console.error('Использование: audit-identity-evidence.mjs --out reports/new-identity-evidence.json внутри проекта.');process.exit(2);
}
try{
  try{await stat(path);console.error('Файл отчёта уже существует. Укажите новое имя.');process.exit(2);}catch(e){if(e.code!=='ENOENT')throw e;}
  const mapFile='docs/evidence/s3-01-ti12-map-accounts.json',ledgerFile='docs/evidence/s3-01-ti12-identity-ledger.json';
  const previousFile='docs/evidence/s3-01-ti12-profile-evidence.manifest.json';
  const [mapBytes,ledgerBytes,previousBytes]=await Promise.all([mapFile,ledgerFile,previousFile].map(f=>readFile(resolve(root,f))));
  const map=JSON.parse(mapBytes),rawLedger=JSON.parse(ledgerBytes),ledger=IdentityLedgerSnapshotSchema.parse(rawLedger),previous=JSON.parse(previousBytes);
  const mapObservation={file:mapFile,sha256:hash(mapBytes)};
  for(const bound of [previous.mapObservation,rawLedger.mapObservation]){
    if(bound?.file!==mapFile||bound.sha256!==mapObservation.sha256)throw new Error('map_observation_hash');
  }
  const base=auditHistoricalMapAccounts([],map,new Date().toISOString()),ids=base.players.flatMap(p=>p.accountId===null?[]:[p.accountId]);
  if(ids.length!==10||JSON.stringify([...ids].sort())!==JSON.stringify([...ledger.accountIds].sort())||ledger.observedAt>new Date().toISOString())
    throw new Error('identity_ledger_selection');
  // Exact 2023 registry URL; first indexed capture, independent of outcomes and team tags. Normally two HTTP requests.
  const client=new ArchiveEvidenceClient(),sources=[],errors=[];let lookup=null,proof=null;
  try{
    const index=await client.findProRegistryBefore(base.startedAt);sources.push(index.source);lookup=index.records;
    if(index.records.length){const selected=index.records[0],s=await client.getProRegistrySnapshot(selected.original,selected.timestamp);
      sources.push(s.source);proof=verifyArchivedProRegistry({...s,digest:selected.digest,fetchedAt:s.source.fetchedAt},ids);}
  }catch(e){errors.push({code:e instanceof ValvePatchError?e.code:'registry_verification_failed',status:e instanceof ValvePatchError?e.status:null});}
  const generatedAt=new Date().toISOString(),review=proof===null?null:assessRegistryIdentityEvidence(proof,map,ledger,generatedAt);
  const files=['scripts/audit-identity-evidence.mjs','packages/ingestion/src/opendota/registry-evidence.ts',
    'packages/ingestion/src/valve/archive-client.ts','packages/ingestion/src/valve/archive-evidence.ts',
    'packages/ingestion/src/valve/team-account-evidence.ts','packages/ingestion/src/valve/steam-profile-evidence.ts',
    'packages/db/src/identity.ts','packages/contracts/src/identity.ts',
    'packages/ingestion/dist/opendota/registry-evidence.js','packages/ingestion/dist/valve/archive-client.js',
    'packages/db/dist/identity.js','packages/contracts/dist/identity.js','pnpm-lock.yaml'];
  const code=await Promise.all(files.map(async file=>({file,sha256:hash(await readFile(resolve(root,file)))})));
  const report={schemaVersion:1,mode:'live_archived_registry_with_frozen_identity_review',generatedAt,
    captureStatus:errors.length?'partial_or_blocked':review?.registryObservedAccounts===ids.length?'complete':'partial_archive_coverage',
    mapObservation,identityLedger:{file:ledgerFile,sha256:hash(ledgerBytes),observedAt:ledger.observedAt,registryRevision:ledger.registryRevision},
    previousEvidenceManifest:{file:previousFile,sha256:hash(previousBytes)},sources,lookup,proof,review,code,requests:client.requestStats,errors,
    scope:'source_accounts_and_frozen_existing_identity_ledger',databaseWrites:0,canonicalPlayersCreated:0,verifiedMapLineups:0,
    trainingExamples:0,strictDatasetStatus:'unavailable',trainingReady:false,deployable:false};
  const content=JSON.stringify(report,null,2)+'\n';await mkdir(dirname(path),{recursive:true});await writeFile(path,content,{flag:'wx'});
  console.log(JSON.stringify({file:rel.replaceAll('\\','/'),sha256:hash(content),captureStatus:report.captureStatus,
    registryObservedAccounts:review?.registryObservedAccounts??null,canonicalVerifiedAccounts:review?.canonicalVerifiedAccounts??null,
    ledgerObservedAt:ledger.observedAt,trainingExamples:0,requests:report.requests,errors}));
  if(report.captureStatus!=='complete')process.exitCode=3;
}catch{console.error('Аудит identity evidence не выполнен. Проверьте сохранённую карту, снимок связей, SHA, сборку и новый путь отчёта.');process.exitCode=1;}
