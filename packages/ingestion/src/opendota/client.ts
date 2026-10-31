import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MatchSchema, MatchSourceSchema, HeroesSchema, LeaguesSchema, PlayerSchema, ProMatchesSchema, ProviderIdSchema, TeamPlayersSchema, TeamSchema } from './schemas.js';

export const OPENDOTA_ADAPTER_VERSION = 'opendota-provider-v2';
export type ProviderErrorCode = 'invalid_configuration' | 'invalid_id' | 'request_budget_exhausted'
  | 'source_rate_limited' | 'source_http_error' | 'source_timeout' | 'source_network_error'
  | 'source_response_too_large' | 'source_invalid_json' | 'source_schema_invalid' | 'source_id_mismatch';

export class OpenDotaError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly endpoint: string | null = null,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly fields: readonly string[] = []
  ) {
    super(`Источник OpenDota недоступен: ${code}`);
    this.name = 'OpenDotaError';
  }
}

export interface ProviderObservation<T> {
  readonly data: T;
  // Internal evidence only. Callers must not log this or expose it in reports.
  readonly rawBody: string;
  readonly source: {
    readonly provider: 'opendota';
    readonly adapterVersion: string;
    readonly endpoint: string;
    readonly fetchedAt: string;
    readonly knownAt: null;
    readonly payloadSha256: string;
    readonly attempts: number;
    readonly rateLimitRemaining: { readonly minute: number | null; readonly day: number | null; readonly month: number | null };
  };
}

const OptionsSchema = z.object({
  baseUrl: z.literal('https://api.opendota.com/api').default('https://api.opendota.com/api'),
  apiKey: z.string().optional(),
  requestsPerMinute: z.number().int().min(1).max(45).default(45),
  // This is an attempt budget for one client/run, NOT durable monthly accounting.
  maxRequests: z.number().int().min(1).max(200).default(25),
  attempts: z.number().int().min(1).max(3).default(3),
  timeoutMs: z.number().int().min(1).max(60000).default(15000),
  maxWaitMs: z.number().int().min(0).max(60000).default(30000),
  maxResponseBytes: z.number().int().min(1).max(16 * 1024 * 1024).default(8 * 1024 * 1024)
});
type Options = Omit<z.input<typeof OptionsSchema>, 'baseUrl'> & { baseUrl?: string };
export interface ProviderBudget {
  beforeRequest(): Promise<void>;
  observe(status: number, retryAfterMs: number | null, remaining: { minute: number | null; day: number | null; month: number | null }): Promise<void>;
}
interface Dependencies {
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  budget?: ProviderBudget;
  signal?: AbortSignal;
}

export function retryAfterMilliseconds(value: string | null, now: number): number | null {
  if (value === null) return null;
  if (/^\d+$/.test(value.trim())) {
    const ms = Number(value) * 1000;
    return Number.isSafeInteger(ms) ? ms : null;
  }
  if (/^[+-]?\d/.test(value.trim())) return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export class OpenDotaClient {
  private readonly options: z.infer<typeof OptionsSchema>;
  private readonly fetcher: NonNullable<Dependencies['fetch']>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private tail = Promise.resolve();
  private nextRequestAt = 0;
  private retryAt = 0;
  private used = 0;
  private readonly httpStatuses: Record<string, number> = {};
  private readonly transportErrors: Record<string, number> = {};
  private readonly budget: ProviderBudget | undefined;
  private readonly signal: AbortSignal | undefined;

  constructor(options: Options = {}, dependencies: Dependencies = {}) {
    const parsed = OptionsSchema.safeParse(options);
    if (!parsed.success) throw new OpenDotaError('invalid_configuration');
    this.options = parsed.data;
    this.fetcher = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.random = dependencies.random ?? Math.random;
    this.budget = dependencies.budget;
    this.signal = dependencies.signal;
  }

  get requestsUsed() { return this.used; }
  get requestStats() { return { attempts: this.used, httpStatuses: { ...this.httpStatuses }, transportErrors: { ...this.transportErrors } }; }
  getProMatches() { return this.request('/proMatches', ProMatchesSchema); }
  getLeagueMatches(id: string) { return this.request(`/leagues/${this.id(id)}/matches`, ProMatchesSchema); }
  getHeroes() { return this.request('/heroes', HeroesSchema); }
  getLeagues() { return this.request('/leagues', LeaguesSchema); }
  async getMatchSource(id: string) {
    const expected = this.id(id);
    const result = await this.request(`/matches/${expected}`, MatchSourceSchema);
    if (result.data.match_id !== expected) throw new OpenDotaError('source_id_mismatch', result.source.endpoint);
    return result;
  }
  async getMatch(id: string) {
    const expected = this.id(id);
    const result = await this.request(`/matches/${expected}`, MatchSchema);
    if (result.data.match_id !== expected) throw new OpenDotaError('source_id_mismatch', result.source.endpoint);
    return result;
  }
  async getTeam(id: string) {
    const expected = this.id(id);
    const result = await this.request(`/teams/${expected}`, TeamSchema);
    if (result.data.team_id !== expected) throw new OpenDotaError('source_id_mismatch', result.source.endpoint);
    return result;
  }
  getTeamPlayers(id: string) { return this.request(`/teams/${this.id(id)}/players`, TeamPlayersSchema); }
  async getPlayer(id: string) {
    const expected = this.id(id);
    if (BigInt(expected) > 4294967295n) throw new OpenDotaError('invalid_id');
    const result = await this.request(`/players/${expected}`, PlayerSchema);
    const actual = result.data.profile?.account_id;
    if (actual != null && actual !== expected) throw new OpenDotaError('source_id_mismatch', result.source.endpoint);
    return result;
  }

  private id(value: string) {
    const parsed = ProviderIdSchema.safeParse(value);
    if (!parsed.success) throw new OpenDotaError('invalid_id');
    return parsed.data;
  }

  private request<T>(endpoint: string, schema: z.ZodType<T>): Promise<ProviderObservation<T>> {
    const operation = this.tail.then(() => this.perform(endpoint, schema));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async perform<T>(endpoint: string, schema: z.ZodType<T>): Promise<ProviderObservation<T>> {
    for (let attempt = 1; attempt <= this.options.attempts; attempt++) {
      if(this.signal?.aborted)throw new OpenDotaError('source_network_error',endpoint);
      if (this.used >= this.options.maxRequests) throw new OpenDotaError('request_budget_exhausted', endpoint);
      const providerWait = Math.max(0, this.retryAt - this.now());
      if (providerWait > this.options.maxWaitMs) throw new OpenDotaError('source_rate_limited', endpoint, null, providerWait);
      const wait = Math.max(0, this.nextRequestAt - this.now(), providerWait);
      if (wait) await this.sleep(wait);
      await this.budget?.beforeRequest();
      this.nextRequestAt = this.now() + Math.ceil(60000 / this.options.requestsPerMinute);
      this.used++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      let retry: OpenDotaError | null = null;
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
        const response = await this.fetcher(new URL(this.options.baseUrl + endpoint), {
          method: 'GET', headers, signal: this.signal?AbortSignal.any([controller.signal,this.signal]):controller.signal, redirect: 'error'
        });
        this.httpStatuses[String(response.status)] = (this.httpStatuses[String(response.status)] ?? 0) + 1;
        const remaining = (period: string) => {
          const value = response.headers.get(`x-rate-limit-remaining-${period}`);
          return value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
        };
        const rateLimitRemaining = { minute: remaining('minute'), day: remaining('day'), month: remaining('month') };
        await this.budget?.observe(response.status,
          retryAfterMilliseconds(response.headers.get('retry-after'), this.now()), rateLimitRemaining);
        if (!response.ok) {
          const retryAfter = retryAfterMilliseconds(response.headers.get('retry-after'), this.now());
          const code = response.status === 429 ? 'source_rate_limited' : 'source_http_error';
          const error = new OpenDotaError(code, endpoint, response.status, retryAfter);
          await response.body?.cancel();
          if (response.status !== 429 && response.status < 500) throw error;
          retry = error;
        } else {
          const body = await this.readBody(response, this.signal?AbortSignal.any([controller.signal,this.signal]):controller.signal, endpoint);
          let payload: unknown;
          let rawBody: string;
          try {
            rawBody = new TextDecoder('utf-8', { fatal: true }).decode(body);
            payload = JSON.parse(rawBody);
          } catch { throw new OpenDotaError('source_invalid_json', endpoint); }
          const parsed = schema.safeParse(payload);
          if (!parsed.success) {
            throw new OpenDotaError('source_schema_invalid', endpoint, null, null,
              parsed.error.issues.slice(0, 10).map(issue => issue.path.join('.')));
          }
          return { data: parsed.data, rawBody, source: {
            provider: 'opendota', adapterVersion: OPENDOTA_ADAPTER_VERSION, endpoint,
            fetchedAt: new Date(this.now()).toISOString(), knownAt: null,
            payloadSha256: createHash('sha256').update(body).digest('hex'), attempts: attempt,
            rateLimitRemaining
          } };
        }
      } catch (error) {
        if (error instanceof OpenDotaError) throw error;
        // Provider/network error text may contain URLs or credentials. Never echo it.
        const code = controller.signal.aborted ? 'source_timeout' : 'source_network_error';
        this.transportErrors[code] = (this.transportErrors[code] ?? 0) + 1;
        retry = new OpenDotaError(code, endpoint);
      } finally { clearTimeout(timer); }

      if (retry === null) throw new OpenDotaError('source_network_error', endpoint);
      const backoff = Math.ceil(500 * 2 ** (attempt - 1) + this.random() * 250);
      const delay = Math.max(backoff, retry.retryAfterMs ?? 0);
      this.retryAt = Math.max(this.retryAt, this.now() + delay);
      if (attempt === this.options.attempts || delay > this.options.maxWaitMs) throw retry;
    }
    throw new OpenDotaError('source_network_error', endpoint);
  }

  private async readBody(response: Response, signal: AbortSignal, endpoint: string): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > this.options.maxResponseBytes) throw new OpenDotaError('source_response_too_large', endpoint);
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks);
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
