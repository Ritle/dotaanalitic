import { z } from 'zod';

const ConfigSchema = z.object({
  RANKED_PRACTICE_ENABLED:z.enum(['true','false']).default('false').transform(v=>v==='true'),
  ROLE_PROFILES_ENABLED:z.enum(['true','false']).default('false').transform(v=>v==='true'),
  STRATZ_API_TOKEN:z.preprocess(value=>typeof value==='string'?(value.trim()?value.trim().replace(/^Bearer\s+/i,''):undefined):value,z.string().trim().min(1).max(4096).regex(/^[!-~]+$/).optional()),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_HOST: z.string().trim().min(1).default('127.0.0.1'),
  WEB_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://localhost:5173'),
  AUTH_COOKIE_SECRET: z.preprocess(value => value === '' ? undefined : value, z.string().min(32).optional()),
  PANDASCORE_API_TOKEN:z.preprocess(value=>typeof value==='string'&&!value.trim()?undefined:value,z.string().trim().min(1).max(4096).regex(/^[!-~]+$/).optional())
}).superRefine((config, ctx) => {
  // Zod can run refinements after a format issue; preserve sanitized field-only
  // errors rather than letting URL() throw with the original input attached.
  if (!URL.canParse(config.WEB_ORIGIN)) return;
  const origin = new URL(config.WEB_ORIGIN);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    ctx.addIssue({code:'custom',path:['WEB_ORIGIN'],message:'Origin required'});
  if (origin.protocol !== 'https:' && (config.NODE_ENV === 'production' || !['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))
    ctx.addIssue({code:'custom',path:['WEB_ORIGIN'],message:'HTTPS required outside local development'});
  if (config.NODE_ENV === 'production' && !config.AUTH_COOKIE_SECRET)
    ctx.addIssue({code:'custom',path:['AUTH_COOKIE_SECRET'],message:'Persistent secret required'});
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    // Include field names only; never echo environment values or secrets.
    const fields = [...new Set(result.error.issues.map(issue => issue.path.join('.')))];
    throw new Error(`Некорректная конфигурация: ${fields.join(', ')}`);
  }
  return { ...result.data, WEB_ORIGIN: new URL(result.data.WEB_ORIGIN).origin };
}
export type AppConfig = ReturnType<typeof readConfig>;
