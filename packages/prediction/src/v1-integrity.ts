import { createHash } from 'node:crypto';
export const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const compareNumeric = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
export function canonicalV1Json(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalV1Json).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .sort(([a], [b]) => compareText(a, b)).map(([key, item]) => JSON.stringify(key) + ':' + canonicalV1Json(item)).join(',') + '}';
  return JSON.stringify(value);
}
export const hashV1 = (value: unknown) => createHash('sha256').update(canonicalV1Json(value)).digest('hex');
