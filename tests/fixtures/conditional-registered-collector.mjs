import {readFile} from 'node:fs/promises';
import {realRegistrationFixture} from './conditional-real-registration.mjs';
import {realSha} from '../../tools/research/conditional-real-registration.mjs';
export const collectorPaths=['tools/research/conditional-registered-collector.mjs','tools/research/conditional-registered-collector-store.mjs'];
export const collectionAt='2026-12-19T00:00:00.000Z';
export async function collectorFixture(owner){
 const p=await realRegistrationFixture(owner);
 for(const path of collectorPaths)p.executable.code[path]=realSha(await readFile(path));
 const packageText=JSON.stringify(p),id='22222222-2222-4222-8222-222222222222';
 const registration={id,packageText,packageSha256:realSha(packageText),recordedAt:'2026-11-15T01:00:00.000Z',
  registeredAt:'2026-11-15T01:00:01.000Z',status:'registered_plan_only',clockBasis:'postgres_observed_commit'};
 const log={format:'conditional-registered-collection-v1',registrationId:id,registrationSha256:registration.packageSha256,
  syntheticOnly:true,snapshotAt:collectionAt,events:[]};
 return {p,registration,log};
}
let next=1;
export const uid=()=>`33333333-3333-4333-8333-${String(next++).padStart(12,'0')}`;
export function scan(f,at=collectionAt){const id=uid();f.log.events.push({kind:'scan_started',sequence:f.log.events.length,scanId:id,at});return id;}
export function begin(f,endpoint,at=collectionAt){const requestId=uid();f.log.events.push({kind:'request_started',sequence:f.log.events.length,requestId,endpoint,at});return requestId;}
export function finish(f,requestId,body,at=collectionAt){const rawBody=typeof body==='string'?body:JSON.stringify(body);
 f.log.events.push({kind:'request_finished',sequence:f.log.events.length,requestId,at,result:{status:'captured',rawBody,payloadSha256:realSha(rawBody)}});}
export function response(f,endpoint,body,at=collectionAt){const id=begin(f,endpoint,at);finish(f,id,body,at);}
export const map=(id='9007199254741201',overrides={})=>({match_id:id,start_time:Math.floor(Date.parse('2026-12-03T00:00:00.000Z')/1000),
 leagueid:'90001',series_id:'999999999',radiant_team_id:'10',dire_team_id:'20',...overrides});
