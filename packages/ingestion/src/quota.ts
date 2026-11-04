import { sql, type Db } from '@dota/db';
import { z } from 'zod';
import { OpenDotaError, type ProviderBudget } from './opendota/client.js';

const LimitsSchema = z.object({ rpm: z.number().int().min(1).max(45).default(45),
  daily: z.number().int().min(1).max(3000).default(2000),
  monthly: z.number().int().min(1).max(45000).default(45000) });
type Limits = z.input<typeof LimitsSchema>;
interface QuotaRow {
  minute_used: number; day_used: number; month_used: number;
  wait_ms: string; now: Date; minute_end: Date; day_end: Date; month_end: Date;
}
export class PostgresProviderBudget implements ProviderBudget {
  private readonly limits: z.infer<typeof LimitsSchema>;
  constructor(private readonly db: Db, limits: Limits = {},
    private readonly sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
    this.limits = LimitsSchema.parse(limits);
  }

  async claim(): Promise<{ allowed: boolean; retryAfterMs: number; period: 'minute' | 'day' | 'month' | 'cooldown' | null }> {
    return this.db.transaction().execute(async tx => {
      await sql`INSERT INTO provider_quotas(provider,minute_start,day_start,month_start)
        VALUES ('opendota',date_trunc('minute',now(),'UTC'),date_trunc('day',now(),'UTC'),date_trunc('month',now(),'UTC'))
        ON CONFLICT (provider) DO NOTHING`.execute(tx);
      await sql`SELECT provider FROM provider_quotas WHERE provider='opendota' FOR UPDATE`.execute(tx);
      await sql`UPDATE provider_quotas SET
        minute_used=CASE WHEN minute_start < date_trunc('minute',now(),'UTC') THEN 0 ELSE minute_used END,
        day_used=CASE WHEN day_start < date_trunc('day',now(),'UTC') THEN 0 ELSE day_used END,
        month_used=CASE WHEN month_start < date_trunc('month',now(),'UTC') THEN 0 ELSE month_used END,
        minute_start=date_trunc('minute',now(),'UTC'),day_start=date_trunc('day',now(),'UTC'),month_start=date_trunc('month',now(),'UTC')
        WHERE provider='opendota'`.execute(tx);
      const { rows } = await sql<QuotaRow>`SELECT minute_used,day_used,month_used,clock_timestamp() AS now,
        minute_start+interval '1 minute' AS minute_end,day_start+interval '1 day' AS day_end,
        month_start+interval '1 month' AS month_end,
        greatest(0,ceil(extract(epoch FROM greatest(next_request_at,blocked_until,clock_timestamp())-clock_timestamp())*1000))::bigint AS wait_ms
        FROM provider_quotas WHERE provider='opendota'`.execute(tx);
      const row = rows[0]!;
      for (const [period, used, limit, end] of [
        ['month',row.month_used,this.limits.monthly,row.month_end],
        ['day',row.day_used,this.limits.daily,row.day_end],
        ['minute',row.minute_used,this.limits.rpm,row.minute_end]
      ] as const) if (used >= limit) return { allowed: false, retryAfterMs: Math.max(1,end.getTime()-row.now.getTime()), period };
      if (Number(row.wait_ms) > 0) return { allowed: false, retryAfterMs: Number(row.wait_ms), period: 'cooldown' };
      await sql`UPDATE provider_quotas SET minute_used=minute_used+1,day_used=day_used+1,month_used=month_used+1,
        next_request_at=clock_timestamp()+${Math.ceil(60000/this.limits.rpm)}*interval '1 millisecond'
        WHERE provider='opendota'`.execute(tx);
      return { allowed: true, retryAfterMs: 0, period: null };
    });
  }

  async beforeRequest() {
    for (let attempt=0;attempt<3;attempt++) {
      const permit=await this.claim();
      if (permit.allowed) return;
      if (permit.retryAfterMs <= 2000 && attempt < 2) { await this.sleep(permit.retryAfterMs+1); continue; }
      throw new OpenDotaError(permit.period==='day'||permit.period==='month' ? 'request_budget_exhausted' : 'source_rate_limited',
        null,null,permit.retryAfterMs);
    }
  }

  async observe(status: number, retryAfterMs: number | null, remaining: { minute: number | null; day: number | null; month: number | null }) {
    await sql`UPDATE provider_quotas SET blocked_until=greatest(blocked_until,
      CASE WHEN ${status}=429 OR ${status}>=500 THEN clock_timestamp()+${retryAfterMs ?? (status===429?60000:0)}*interval '1 millisecond' ELSE '-infinity'::timestamptz END,
      CASE WHEN ${remaining.minute}::integer=0 THEN clock_timestamp()+interval '1 minute' ELSE '-infinity'::timestamptz END,
      CASE WHEN ${remaining.day}::integer=0 THEN date_trunc('day',now(),'UTC')+interval '1 day' ELSE '-infinity'::timestamptz END,
      CASE WHEN ${remaining.month}::integer=0 THEN date_trunc('month',now(),'UTC')+interval '1 month' ELSE '-infinity'::timestamptz END)
      WHERE provider='opendota'`.execute(this.db);
  }
}
