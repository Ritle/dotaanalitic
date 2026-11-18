#!/usr/bin/env node
/** Offline development diagnostics. Never trains, activates, writes the DB or publishes forecasts. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {evaluateSeriesDiagnostic,SERIES_CANDIDATE_POLICY} from '../../packages/prediction/dist/series/candidate.js';
const [input,output,...extra]=process.argv.slice(2);
if(!input||!output||extra.length){console.error('Usage: node tools/research/evaluate-series-candidate.mjs INPUT.json NEW_REPORT.json');process.exit(2);}
try{
 const bytes=await readFile(input);if(bytes.byteLength>8*1024*1024)throw Error('input_too_large');
 const report={...evaluateSeriesDiagnostic(JSON.parse(bytes.toString('utf8'))),inputSha256:createHash('sha256').update(bytes).digest('hex'),policy:SERIES_CANDIDATE_POLICY};
 await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({purpose:report.purpose,deployable:false,n:report.seriesCandidate.n,excluded:report.excluded.length}));
}catch(e){console.error(e?.code==='EEXIST'?'Report already exists; choose a new path.':'Series diagnostic failed: invalid input or output unavailable.');process.exit(1);}
