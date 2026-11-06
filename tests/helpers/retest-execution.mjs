import {protocolFixture} from './retest-protocol.mjs';
import {registerRetestProtocol,sha} from '../../scripts/lib/v1-retest-protocol.mjs';
import {prepareV1Data} from '../../packages/db/dist/v1-data.js';
import {historicalHash} from '../../scripts/lib/v1-historical-execution.mjs';
import {retestExecutionCoverage,verifyRetestCapsule,registerRetestFreeze} from '../../scripts/lib/v1-retest-execution.mjs';
export const text=v=>JSON.stringify(v,null,2)+'\n',evidence=v=>({text:text(v),sha256:sha(text(v))});
export const stamp=v=>{const {fingerprint,...body}=v;return {...body,fingerprint:historicalHash(body)};};
export const preparedAt='2025-11-06T13:00:00.000Z';
export const code=['scripts/retest-v1.mjs','scripts/lib/v1-retest-execution.mjs','scripts/lib/v1-retest-bundle.mjs',
  'scripts/lib/v1-historical-execution.mjs','packages/contracts/dist/v1-retest-execution.js',
  'packages/prediction/dist/v1-features.js','packages/prediction/dist/v1-candidate.js','packages/prediction/dist/v1-quality.js'].map(path=>({path,sha256:'b'.repeat(64)}));
export const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinarySha256:'c'.repeat(64)};
const us=t=>String(BigInt(Date.parse(t))*1000n),ref=(path,v)=>({path,sha256:evidence(v).sha256});
export function fixture(mutate=()=>{}){
  const {ctx,accessEvidence}=protocolFixture(),sources=[];
  const add=v=>{const e=evidence(v);if(!sources.some(s=>s.sha256===e.sha256))sources.push(e);};
  const oldRefs={schemaVersion:1,...Object.fromEntries(Object.entries(ctx.previous.inputs).map(([k,v])=>[k,ref('old-'+k+'.json',v)]))};
  ctx.refs.previous.inputs=ref('old-inputs.json',oldRefs);add(oldRefs);
  for(const key of ['request','proposal','intent','catalogue','fileExposure','databaseExposure','captureIndex','metadataReview','accessReview'])add(ctx[key]);
  ctx.captures.forEach(add);add(accessEvidence);Object.values(ctx.previous.inputs).forEach(add);
  for(const key of ['protocol','freeze','started','report','registry'])add(ctx.previous[key]);
  const protocol=registerRetestProtocol(ctx,'2025-11-06T12:05:00.000Z');
  const players=Array.from({length:10},(_,i)=>({playerSlot:i<5?i:i+123,sourceAccountId:String(i+100)}));
  const ids=['1','2','3','4','5','100000004','100000005','100000007'];
  const candidates=ids.map((id,i)=>{
    const t=ctx.metadataReview.ledger.find(r=>r.matchId===id);
    const start=t?new Date(t.startTime*1000).toISOString():new Date(Date.UTC(2025,0,i+1)).toISOString(),end=new Date(Date.parse(start)+1800000).toISOString();
    const seriesId=`00000000-0000-4000-8000-${String(t?.seriesId??i+1).padStart(12,'0')}`,a=t?.radiantTeamId??'1',b=t?.direTeamId??'2';
    return {matchId:id,startedAtUs:us(start),endedAtUs:us(end),syncedAtUs:us(preparedAt),dataRevision:'1',isPro:true,ingestState:'accepted',radiantWin:i%3!==2,
      radiantTeamId:a,direTeamId:b,seriesId,players:structuredClone(players),receiptPlayers:structuredClone(players),seriesSourceMatched:true,facts:[],
      outcome:{status:'verified',matchId:id,outcomeReceiptId:id,teamAId:a,teamBId:b,teamAWon:i%3!==2,startedAt:start,completedAt:end,seriesId,dataRevision:'1',labelVerifiedAt:preparedAt,
        sourceEvidence:{receiptId:id,payloadSha256:'a'.repeat(64),adapterVersion:'synthetic',normalizerVersion:'synthetic',receiptFetchedAt:preparedAt}}};
  });
  const source={request:{schemaVersion:1,profile:'pre-match-player-elo-data-v1',purpose:'development_only',fromAt:protocol.request.warmupFromAt,toAt:protocol.request.eventCutoffAt,snapshotAt:preparedAt,maxMaps:5000},
    identityRevision:'1',candidates,aliases:[...new Map(candidates.map(m=>[m.seriesId,{seriesId:m.seriesId,provider:'opendota',providerSeriesId:String(Number(m.seriesId.slice(-12))),teamAId:'1',teamBId:'2'}])).values()],
    identities:players.map((p,i)=>({observationId:'proof:'+i,playerId:String(i+1),provider:'opendota',externalAccountId:p.sourceAccountId,status:'verified',eventAt:null,knownAt:preparedAt,fetchedAt:preparedAt,evidenceRef:'synthetic',source:'synthetic'})),
    code:[{path:'synthetic-test.js',sha256:'b'.repeat(64)}],syntheticOnly:true};
  const report={schemaVersion:2,format:'retest-collection-review-v2',protocolFingerprint:protocol.fingerprint,
    collection:{terminal:true},unavailableSources:[],rows:ctx.metadataReview.ledger.map(t=>({matchId:t.matchId,seriesId:t.seriesId,exposureExcluded:t.priorExposure,reasons:[...t.reasons]}))};
  mutate({source,report});
  const closure=stamp({schemaVersion:2,format:'retest-collection-closure-v2',protocolFingerprint:protocol.fingerprint,configSha256:'a'.repeat(64),stateFingerprint:'b'.repeat(64),closedAt:'2025-11-06T12:30:00.000Z',reason:'all_work_terminal',report});
  const manifest=stamp({schemaVersion:2,format:'retest-import-sources-v2',collectionSha256:'c'.repeat(64),closureSha256:evidence(closure).sha256,configSha256:closure.configSha256,protocolFingerprint:protocol.fingerprint,stateFingerprint:closure.stateFingerprint,files:[]});
  const dataset=prepareV1Data(source),plan=stamp({schemaVersion:2,format:'v1-retest-import-plan-v2',reviewedAt:preparedAt,protocolFingerprint:protocol.fingerprint,syntheticOnly:true,
    closureSha256:evidence(closure).sha256,closureFingerprint:closure.fingerprint,sourceManifestFingerprint:manifest.fingerprint,
    canonicalBaseIds:ids.slice(0,5),maps:ids.slice(5).map(matchId=>({matchId,payloadSha256:'a'.repeat(64)})),historyConflictMapIds:[],
    historyWindow:{fromAt:source.request.fromAt,toAt:source.request.toAt,maxMaps:5000},collectionReport:report});
  const capsule=stamp({schemaVersion:2,format:'v1-retest-execution-input-v2',preparedAt,protocol:evidence(protocol),protocolInputs:evidence(ctx.refs),protocolSources:sources,
    closure:evidence(closure),sourceManifest:evidence(manifest),importPlan:evidence(plan),dataset:evidence(dataset),coverage:retestExecutionCoverage(plan,dataset)});
  return bind(capsule);
}
export function bind(capsule){
  const context=verifyRetestCapsule(capsule),capsuleSha=sha(text(capsule)),freeze=registerRetestFreeze(context,capsuleSha,code,runtime,preparedAt),freezeSha=sha(text(freeze));
  const start={schemaVersion:2,format:'v1-retest-first-scoring-v2',startedAt:preparedAt,freezeSha256:freezeSha,freezeFingerprint:freeze.fingerprint,capsuleSha256:capsuleSha};
  return {capsule,context,capsuleSha,freeze,freezeSha,start};
}
