/** Offline, fixed reviewed evidence. Preview first; apply binds the exact plan SHA and rechecks DB state. */
import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDatabase,IdentityProvisioner,IdentityProvisionError,normalizeReviewedAccounts} from '../packages/db/dist/index.js';
import {assessRegistryIdentityEvidence} from '../packages/ingestion/dist/index.js';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),mode=args[0],sha=b=>createHash('sha256').update(b).digest('hex');
function local(file){const path=resolve(root,file),rel=relative(root,path);if(!rel||isAbsolute(rel)||rel.startsWith('..')||!rel.endsWith('.json'))throw new Error('invalid_path');return path;}
const valid=mode==='preview'&&args.length===3&&args[1]==='--out'||
  mode==='apply'&&args.length===7&&args[1]==='--plan'&&args[3]==='--sha256'&&/^[a-f0-9]{64}$/.test(args[4])&&args[5]==='--out';
let out,planPath;
try{if(!valid)throw new Error('usage');out=local(args.at(-1));if(mode==='apply')planPath=local(args[2]);}
catch{console.error('Использование: provision-identity.mjs preview --out report.json | apply --plan preview.json --sha256 SHA --out report.json. Пути внутри проекта.');process.exit(2);}
let db,committed=false;
try{
  try{await stat(out);console.error('Файл отчёта уже существует. Укажите новое имя.');process.exit(2);}catch(e){if(e.code!=='ENOENT')throw e;}
  const reviewFile='docs/evidence/s3-01-ti12-reviewed-accounts.json',reportFile='docs/evidence/s3-01-ti12-registry-evidence.json';
  const read=async file=>{const path=local(file);if((await stat(path)).size>1024*1024)throw new Error('input_size');return readFile(path);};
  const [reviewBytes,sourceBytes,manifestBytes]=await Promise.all([reviewFile,reportFile,'docs/evidence/s3-01-ti12-registry-evidence.manifest.json'].map(read));
  const review=normalizeReviewedAccounts(JSON.parse(reviewBytes)),source=JSON.parse(sourceBytes),manifest=JSON.parse(manifestBytes);
  const mapBytes=await read(source.mapObservation.file),map=JSON.parse(mapBytes),oldLedgerBytes=await read(source.identityLedger.file);
  if(manifest.report.file!==reportFile||manifest.report.sha256!==sha(sourceBytes)||review.source.reportSha256!==sha(sourceBytes)||
    source.mapObservation.sha256!==sha(mapBytes)||review.source.mapSha256!==sha(mapBytes)||source.identityLedger.sha256!==sha(oldLedgerBytes))
    throw new Error('source_binding');
  const oldReview=assessRegistryIdentityEvidence(source.proof,map,JSON.parse(oldLedgerBytes),source.generatedAt);
  const p=source.proof,projected=p.members.map(m=>({accountId:m.accountId,steam64:m.steam64,alias:m.alias}));
  if(oldReview.registryObservedAccounts!==10||review.accounts.length!==10||JSON.stringify(review.accounts)!==JSON.stringify(projected)||
    review.source.payloadSha256!==p.payloadSha256||review.source.projectionSha256!==p.projectionSha256||
    review.source.knownAt!==p.knownByAt||review.source.fetchedAt!==p.fetchedAt||
    !source.sources.some(s=>s.url===review.source.archiveUrl&&s.payloadSha256===p.payloadSha256))throw new Error('review_binding');
  let preview,planBound=null;
  if(mode==='apply'){
    const bytes=await read(relative(root,planPath));if(sha(bytes)!==args[4])throw new Error('plan_hash');preview=JSON.parse(bytes);
    if(preview.mode!=='identity_provision_preview'||preview.review.sha256!==sha(reviewBytes)||
      !/^[a-f0-9]{64}$/.test(preview.plan.fingerprint))throw new Error('plan_binding');
    planBound={file:relative(root,planPath).replaceAll('\\','/'),sha256:sha(bytes)};
  }
  // Validate report destination before touching DB. A post-commit I/O failure is explicitly reported below.
  await mkdir(dirname(out),{recursive:true});
  if(!process.env.DATABASE_URL){console.error('Не задан DATABASE_URL.');process.exit(2);}
  const code=await Promise.all(['scripts/provision-identity.mjs','packages/contracts/src/identity-provision.ts',
    'packages/contracts/dist/identity-provision.js','packages/db/src/identity-provision.ts','packages/db/dist/identity-provision.js',
    'packages/db/src/identity-repository.ts','packages/db/dist/identity-repository.js','packages/db/src/identity.ts','packages/db/dist/identity.js',
    'packages/ingestion/src/opendota/registry-evidence.ts','packages/ingestion/dist/opendota/registry-evidence.js','pnpm-lock.yaml'].map(async file=>
    ({file,sha256:sha(await readFile(resolve(root,file)))})));
  db=createDatabase(process.env.DATABASE_URL);const service=new IdentityProvisioner(db);
  let result;
  if(mode==='preview')result={plan:await service.preview(review),databaseWrites:0};
  else{
    const applied=await service.apply(review,preview.plan.fingerprint);committed=true;
    const {observations,observedAt,registryRevision}=await service.snapshot(review);
    const identityLedger={schemaVersion:1,mode:'read_only_identity_ledger_snapshot',observedAt,
      registryRevision,accountIds:review.accounts.map(a=>a.accountId),
      observations:observations.map(({observationId,...claim})=>({observationId,claim:{...claim,source:'sha256:'+sha(claim.source),
        evidenceRef:claim.evidenceRef===null?null:'sha256:'+sha(claim.evidenceRef)}})),referencesRedactedToSha256:true,
      mapObservation:source.mapObservation,originalObservationFingerprint:sha(JSON.stringify(observations))};
    result={...applied,identityLedger,identityAssessment:assessRegistryIdentityEvidence(p,map,identityLedger,new Date().toISOString()),
      databaseWrites:applied.playersCreated+applied.accountProofsAdded+applied.aliasesAdded};
  }
  const report={schemaVersion:1,mode:'identity_provision_'+mode,generatedAt:new Date().toISOString(),
    review:{file:reviewFile,sha256:sha(reviewBytes)},sourceReport:{file:reportFile,sha256:sha(sourceBytes)},planInput:planBound,...result,code,
    networkRequests:0,verifiedMapLineups:0,trainingExamples:0,strictDatasetStatus:'unavailable',trainingReady:false,deployable:false};
  const content=JSON.stringify(report,null,2)+'\n';await writeFile(out,content,{flag:'wx'});
  console.log(JSON.stringify({file:relative(root,out).replaceAll('\\','/'),sha256:sha(content),status:result.status??result.plan.status,
    plannedPlayers:result.plan?.plannedPlayers,playersCreated:result.playersCreated,accountProofsAdded:result.accountProofsAdded,
    aliasesAdded:result.aliasesAdded,canonicalVerifiedAccounts:result.identityAssessment?.canonicalVerifiedAccounts,trainingExamples:0}));
  if(result.plan?.status==='blocked')process.exitCode=3;
}catch(e){
  if(committed)console.error('Изменения БД уже зафиксированы, но отчёт не сохранён. Повторите тот же план с новым именем отчёта: операция идемпотентна.');
  else if(e instanceof IdentityProvisionError)console.error(e.code==='identity_plan_stale'?'План устарел. Создайте новый preview; запись отменена.':
    e.code==='identity_provision_conflict'?'Обнаружен конфликт связей. Вся операция отменена.':'Проверка реестра не пройдена. Запись отменена.');
  else console.error('Привязка аккаунтов не выполнена. Проверьте исходные SHA, план, PostgreSQL и доступ к файлам.');
  process.exitCode=1;
}finally{await db?.destroy();}
