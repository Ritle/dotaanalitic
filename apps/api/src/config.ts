import { z } from 'zod';

const ConfigSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_HOST: z.string().trim().min(1).default('127.0.0.1'),
  WEB_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://localhost:5173')
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    // Include field names only; never echo environment values or secrets.
    const fields = [...new Set(result.error.issues.map(issue => issue.path.join('.')))];
    throw new Error(`Некорректная конфигурация: ${fields.join(', ')}`);
  }
  return result.data;
}
