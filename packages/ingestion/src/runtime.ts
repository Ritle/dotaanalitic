import { createDatabase } from '@dota/db';
import { z } from 'zod';
import { OpenDotaClient, OpenDotaError } from './opendota/client.js';
import { PostgresProviderBudget } from './quota.js';

export function createProviderRuntime(env: NodeJS.ProcessEnv, maxRequests=25) {
  const parsed=z.object({ DATABASE_URL:z.string().min(1), OPENDOTA_RPM_BUDGET:z.coerce.number().int().min(1).max(45).default(45),
    OPENDOTA_DAILY_BUDGET:z.coerce.number().int().min(1).max(3000).default(2000),
    OPENDOTA_MONTHLY_BUDGET:z.coerce.number().int().min(1).max(45000).default(45000) }).safeParse(env);
  if(!parsed.success) throw new OpenDotaError('invalid_configuration');
  const config=parsed.data;
  const db=createDatabase(config.DATABASE_URL);
  const budget=new PostgresProviderBudget(db,{rpm:config.OPENDOTA_RPM_BUDGET,daily:config.OPENDOTA_DAILY_BUDGET,monthly:config.OPENDOTA_MONTHLY_BUDGET});
  const clientForJob=(signal?:AbortSignal)=>new OpenDotaClient({ baseUrl:env.OPENDOTA_BASE_URL,apiKey:env.OPENDOTA_API_KEY,
    requestsPerMinute:config.OPENDOTA_RPM_BUDGET,maxRequests },{budget,signal});
  return {db,client:clientForJob(),clientForJob,close:()=>db.destroy()};
}
