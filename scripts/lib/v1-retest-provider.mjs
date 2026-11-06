import {createDatabase} from '../../packages/db/dist/index.js';
import {PostgresProviderBudget} from '../../packages/ingestion/dist/quota.js';
import {OpenDotaClient} from '../../packages/ingestion/dist/opendota/client.js';
import {OpenDotaPlayerHistoryClient} from '../../packages/ingestion/dist/opendota/player-history.js';
import {fail} from './v1-retest-collection.mjs';
/** The hook durably admits EVERY HTTP attempt, including internal history retries. */
export function retestDeadlineFetch(deadline,fetcher=globalThis.fetch,now=()=>new Date().toISOString()){
 return (url,init)=>{if(now()>=deadline)fail('deadline');return fetcher(url,init);};
}
export async function retestProvider(limit,hooks,deadline){
 if(!process.env.DATABASE_URL)fail('database_required');
 const limits={rpm:Number(process.env.OPENDOTA_RPM_BUDGET??45),daily:Number(process.env.OPENDOTA_DAILY_BUDGET??2000),monthly:Number(process.env.OPENDOTA_MONTHLY_BUDGET??45000)};
 if(!Object.values(limits).every(Number.isSafeInteger)||limits.rpm<1||limits.rpm>45||limits.daily<1||limits.daily>3000||limits.monthly<1||limits.monthly>45000)fail('quota_configuration');
 const db=createDatabase(process.env.DATABASE_URL),durable=new PostgresProviderBudget(db,limits),statuses={};
 const budget={beforeRequest:async()=>{hooks.guard();await durable.beforeRequest();await hooks.beforeRequest();},
  observe:async(status,delay,remaining)=>{statuses[status]=(statuses[status]??0)+1;await hooks.observe(status,delay);await durable.observe(status,delay,remaining);}};
 const fetcher=retestDeadlineFetch(deadline);
 const client=new OpenDotaClient({apiKey:process.env.OPENDOTA_API_KEY,maxRequests:limit,attempts:1},{budget,fetch:fetcher});
 const history=new OpenDotaPlayerHistoryClient(budget,{apiKey:process.env.OPENDOTA_API_KEY},fetcher);
 return {client,discover:(...args)=>history.discover(...args),httpStatuses:()=>({...statuses}),close:()=>db.destroy()};
}
