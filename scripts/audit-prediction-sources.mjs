#!/usr/bin/env node
/** Non-destructive OpenDota field-coverage audit. No model predictions, no raw payload storage. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { inspectMatch } from './lib/match-quality.mjs';

const argv = process.argv.slice(2);
function arg(name, fallback) { const i=argv.indexOf(name); return i===-1?fallback:argv[i+1]; }
const fixture=arg('--fixture', null);
const sample=Number(arg('--sample',20));
const output=arg('--out', null);
if(!Number.isInteger(sample)||sample<1||sample>50) {console.error('--sample must be 1..50'); process.exit(2);}
const KEY=process.env.OPENDOTA_API_KEY;
const FIELDS=['match_id_consistent','start_time','outcome','teams_2','league','series','patch','players_10','identity_10','heroes_10_unique','picks_10','draft_actions','role_hint_10','final_heroes_valid','draft_picks_exact','draft_heroes_match','draft_teams_match','draft_order_integrity','draft_structurally_consistent','draft_order_valid'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let lastRequestAt=0;
async function get(url) {
  for(let attempt=0;attempt<3;attempt++) {
    const delay=Math.max(0,1600-(Date.now()-lastRequestAt));
    if(delay) await sleep(delay);
    lastRequestAt=Date.now();
    const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),15000);
    let response;
    try { response=await fetch(url,{signal:ac.signal}); } finally {clearTimeout(timer);}
    if(response.ok) return response.json();
    if((response.status===429||response.status>=500)&&attempt<2) {
      const raw=response.headers.get('retry-after'); let wait=2500*(attempt+1);
      if(raw) { const asSec=Number(raw); if(Number.isFinite(asSec)) wait=Math.max(wait,asSec*1000); else {const dt=Date.parse(raw);if(Number.isFinite(dt))wait=Math.max(wait,dt-Date.now());}}
      await sleep(Math.min(wait,60000)); continue;
    }
    throw new Error(`HTTP ${response.status} at ${new URL(url).pathname}`);
  }
}
function validId(x){return Number.isSafeInteger(x)&&x>0;}
try {
  let discovered, details;
  if(fixture){const f=JSON.parse(await readFile(fixture,'utf8'));discovered=f.proMatches;details=f.details; if(!Array.isArray(discovered)||typeof details!=='object') throw new Error('fixture requires proMatches and details');}
  else {const query=KEY?`?api_key=${encodeURIComponent(KEY)}`:''; discovered=await get(`https://api.opendota.com/api/proMatches${query}`);}
  if(!Array.isArray(discovered))throw new Error('/proMatches did not return array');
  const ids=[...new Set(discovered.map(x=>x?.match_id).filter(validId))].slice(0,sample);
  if(ids.length===0)throw new Error('no valid match IDs in proMatches');
  const rows=[]; const errors=[];
  for(const id of ids){
    try{
      const m=fixture?details[String(id)]:await get(`https://api.opendota.com/api/matches/${id}${KEY?`?api_key=${encodeURIComponent(KEY)}`:''}`);
      if(!m)throw new Error('missing fixture detail');
      const quality=inspectMatch(m,id);
      rows.push({match_id:String(id),...quality});
    } catch(e){errors.push({match_id:String(id),error:String(e.message).slice(0,150)});}
  }
  // Null = unassessed, NOT a failed historical patch-specific draft validation.
  const coverage=Object.fromEntries(FIELDS.map(k=>{
    const assessed=rows.filter(x=>x.flags[k]!==null);
    const good=assessed.filter(x=>x.flags[k]===true);
    return [k,{count:good.length,of:assessed.length,ratio:assessed.length?Number((good.length/assessed.length).toFixed(4)):null,missing_match_ids:assessed.filter(x=>x.flags[k]===false).map(x=>x.match_id),not_assessed_match_ids:rows.filter(x=>x.flags[k]===null).map(x=>x.match_id)}];
  }));
  const anomalyByCode={};
  for (const row of rows) for(const code of row.anomalies) {
    if(!anomalyByCode[code])anomalyByCode[code]=[];
    anomalyByCode[code].push(row.match_id);
  }
  const report={schema_version:2,mode:fixture?'synthetic_fixture':'live_opendota',generated_at:new Date().toISOString(),requested:sample,discovered:ids.length,details_received:rows.length,details_failed:errors.length,limitations:['Recent pro match IDs only, not a stratified historical sample','draft_order_valid is NOT assessed without historical rules for mode/patch','Nonempty picks_bans does NOT prove timeline integrity','Final heroes may be known only retrospectively; not guaranteed known at pre/post cutoff','No model trained; no raw payloads saved','Null/unknown role or patch must not be guessed'],coverage,anomalies:anomalyByCode,details:rows.filter(x=>x.anomalies.length>0).map(x=>({match_id:x.match_id,anomalies:x.anomalies,diagnostics:x.diagnostics})),errors};
  if(output){await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify(report,null,2));
  if(rows.length===0)process.exitCode=1;
} catch(e){console.error(`audit failed: ${e.message}`);process.exitCode=1;}
