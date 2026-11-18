/** Replays the fixed source experiment. Observed metadata never activates a model. */
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PLAN_SHA,sha,safeId} from './draft-target-source-pilot.mjs';
const directory='.tools/s304-source-pilot-r1';
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;

export function inspectPanda(payload,expectedId){
  const reasons=[];
  if(safeId(payload?.id)!==expectedId)reasons.push('MATCH_ID_MISMATCH');
  const games=Array.isArray(payload?.games)&&payload.games.length<=20?payload.games:null;
  if(!games)reasons.push('GAMES_INVALID');
  const rows=(games??[]).map(game=>({
    pandaGameId:safeId(game?.id),pandaMatchId:safeId(game?.match_id),
    position:Number.isSafeInteger(game?.position)&&game.position>=1&&game.position<=20?game.position:null,
    beginAt:iso(game?.begin_at),endAt:iso(game?.end_at),
    elapsedMinusLengthSeconds:iso(game?.begin_at)&&iso(game?.end_at)&&Number.isSafeInteger(game?.length)&&game.length>=0?
      (Date.parse(game.end_at)-Date.parse(game.begin_at))/1000-game.length:null,
    nativeDotaMapId:null,gameplayStartVerified:false
  }));
  if(rows.some(r=>r.pandaGameId===null||r.pandaMatchId!==expectedId||r.position===null))reasons.push('GAME_ID_PARENT_OR_POSITION_INVALID');
  if(new Set(rows.map(r=>r.position)).size!==rows.length||new Set(rows.map(r=>r.pandaGameId)).size!==rows.length)reasons.push('DUPLICATE_GAME_OR_POSITION');
  return {pandaMatchId:expectedId,validSummary:reasons.length===0,reasons,games:rows,
    explicitPositions:reasons.length?0:rows.length,nativeMapBindings:0,prestartVerified:0};
}

export function inspectStratz(payload,ids){
  return ids.map((id,index)=>{
    const row=payload?.data?.[`m${index}`],series=safeId(row?.seriesId),members=row?.series?.matches;
    const valid=!(payload?.errors?.length)&&safeId(row?.id)===id&&series!==null&&safeId(row?.series?.id)===series&&
      Array.isArray(members)&&members.length>0&&members.length<=20&&
      members.every(m=>safeId(m?.id)!==null&&safeId(m?.seriesId)===series)&&
      new Set(members.map(m=>safeId(m.id))).size===members.length&&members.some(m=>safeId(m.id)===id);
    return {nativeDotaMapId:id,seriesId:valid?series:null,seriesMembershipObserved:valid,
      returnedMemberIds:valid?members.map(m=>safeId(m.id)):[],startDateTime:valid&&Number.isSafeInteger(row.startDateTime)?row.startDateTime:null,
      explicitMapNumber:null,pandaMatchId:null,gameplayStartVerified:false};
  });
}

export function summarize(plan,receipts,bodies){
  const panda=plan.pandaSample.map(item=>{
    const receipt=receipts.requests.find(r=>r.provider==='pandascore'&&r.endpoint===`/matches/${item.id}`);
    return receipt?.result==='captured'?inspectPanda(bodies[receipt.bodyFile],item.id):
      {pandaMatchId:item.id,validSummary:false,reasons:['RESPONSE_UNAVAILABLE'],games:[],explicitPositions:0,nativeMapBindings:0,prestartVerified:0};
  });
  const stratzReceipt=receipts.requests.find(r=>r.provider==='stratz');
  const stratz=inspectStratz(stratzReceipt?.result==='captured'?bodies[stratzReceipt.bodyFile]:null,plan.stratzSample);
  return {format:'draft-target-source-pilot-summary-v1',panda,stratz,
    counts:{pandaSample:plan.pandaSample.length,pandaSummaries:panda.filter(p=>p.validSummary).length,
      explicitPandaPositions:panda.reduce((n,p)=>n+p.explicitPositions,0),stratzSample:plan.stratzSample.length,
      stratzSeriesMemberships:stratz.filter(s=>s.seriesMembershipObserved).length,nativeMapBindings:0,verifiedGameplayStarts:0},
    limitations:['PANDASCORE_GAME_IDS_ARE_NOT_NATIVE_DOTA_IDS','STRATZ_ARRAY_ORDER_IS_NOT_MAP_NUMBER',
      'PROVIDER_START_CLOCK_SEMANTICS_UNVERIFIED','POSTGAME_RECEIPTS_NOT_PRESTART_FEATURE_EVIDENCE'],
    canonicalWrites:0,primaryEligible:false,deployable:false};
}

async function limited(path){assert((await stat(path)).size<=2*1024*1024);return readFile(path);}
export async function replaySourcePilot(dir=directory){
  const planBytes=await limited(`${dir}/plan.json`);assert.equal(sha(planBytes),PLAN_SHA);
  const plan=JSON.parse(planBytes),receiptBytes=await limited(`${dir}/receipts.json`),receipts=JSON.parse(receiptBytes);
  assert.equal(receipts.planSha256,PLAN_SHA);assert.equal(receipts.format,'draft-target-source-pilot-receipts-v1');
  assert.equal(receipts.codeSha256,sha(await readFile(new URL('./draft-target-source-pilot.mjs',import.meta.url))));
  assert(receipts.requests.length<=5);const bodies={},bodyHashes={};
  for(const receipt of receipts.requests){
    if(!receipt.bodyFile)continue;
    assert(/^response-[1-5]\.json$/.test(receipt.bodyFile));assert(!Object.hasOwn(bodies,receipt.bodyFile));
    const bytes=await limited(`${dir}/${receipt.bodyFile}`);assert.equal(sha(bytes),receipt.bodySha256);
    bodies[receipt.bodyFile]=JSON.parse(bytes);bodyHashes[receipt.bodyFile]=sha(bytes);
  }
  return {planSha256:PLAN_SHA,receiptsSha256:sha(receiptBytes),bodyHashes,
    reportCodeSha256:sha(await readFile(new URL(import.meta.url))),result:summarize(plan,receipts,bodies)};
}
async function main(){
  const [mode,expected,...extra]=process.argv.slice(2);assert(extra.length===0);
  const report=await replaySourcePilot(),output=JSON.stringify(report,null,2)+'\n',path=`${directory}/analysis.json`;
  if(mode==='create'){assert(expected===undefined);await writeFile(path,output,{flag:'wx'});}
  else {assert.equal(mode,'verify');const bytes=await limited(path);assert.equal(sha(bytes),expected);assert.equal(bytes.toString(),output);}
  console.log(JSON.stringify({sha256:sha(output),...report.result.counts,status:mode==='create'?'saved':'verified'}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
  console.error('Отчёт источников отклонён: проверьте SHA, исходные ответы и неизменность кода.');process.exitCode=1;
});
