// Explicit synthetic, reviewed-register boundary; not real provider completeness evidence.
import {sourceFixture} from './conditional-source-binding.mjs';
import {T,day} from './conditional-future-holdout.mjs';
import {sourceSha} from '../../tools/research/conditional-future-source-binding.mjs';
const iso=t=>new Date(Number(t/1000n)).toISOString();
export function enrollmentFixture(){
 const f=sourceFixture(),mapIds=f.input.cases.map(c=>c.target.matchId);
 const rows=f.archive.receipts.filter(r=>mapIds.includes(r.matchId)).map(r=>JSON.parse(r.rawBody));
 const registry={format:'reviewed-native-event-register-v1',editionKey:'synthetic-main-2027',leagueId:'300',stage:'main_event',closed:true,
  series:[{nativeSeriesId:'99',state:'finished',mapIds,completedAt:iso(T+day+3600000000n)}]};
 const rawBody=JSON.stringify(rows);
 return {archive:f.archive,input:{format:'conditional-enrollment-input-v1',syntheticOnly:true,snapshotAt:iso(T+3n*day),
  window:{fromAt:iso(T),until:iso(T+2n*day)},scope:[{editionKey:'synthetic-main-2027',leagueId:'300'}],
  pages:[{status:'captured',sequence:0,endpoint:'/leagues/300/matches',fetchedAt:iso(T+3n*day),payloadSha256:sourceSha(rawBody),rawBody}],
  registers:[{reviewedAt:iso(T+3n*day),evidenceRef:'synthetic-reviewed-register',bodySha256:sourceSha(JSON.stringify(registry)),rawBody:JSON.stringify(registry)}],
  preparedTargetIds:mapIds,exposure:{mapIds:[],seriesKeys:[]}}};
}
export function editRegister(f,mutate){const entry=f.input.registers[0],body=JSON.parse(entry.rawBody);mutate(body);entry.rawBody=JSON.stringify(body);entry.bodySha256=sourceSha(entry.rawBody);}
export function editPage(f,mutate){const page=f.input.pages[0],rows=JSON.parse(page.rawBody);mutate(rows);page.rawBody=JSON.stringify(rows);page.payloadSha256=sourceSha(page.rawBody);}
