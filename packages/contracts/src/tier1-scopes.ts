import {z} from 'zod';
import {V1RuntimeRequestSchema} from './v1-runtime.js';
import {CatalogIdSchema} from './catalog.js';

/** Convenience catalogue; the copied scope still passes the original runtime gates. */
export const Tier1ScopeSchema=V1RuntimeRequestSchema.shape.targetScope.unwrap();
const Uuid=z.uuid().transform(v=>v.toLowerCase()),Sha=z.string().regex(/^[a-f0-9]{64}$/);
export const Tier1ScopeWriteSchema=z.object({requestId:Uuid,scopeId:Uuid,expectedRevision:z.number().int().min(0).max(2147483646),
 enabled:z.boolean(),scope:Tier1ScopeSchema}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=16000);
export const Tier1ScopeRecordSchema=z.object({format:z.literal('owner-tier1-scope-v1'),request:Tier1ScopeWriteSchema,
 revision:z.number().int().positive(),previousSha256:Sha.nullable(),recordedAt:z.iso.datetime({precision:6})}).strict();
export const Tier1ScopeSavedSchema=z.object({record:Tier1ScopeRecordSchema,sha256:Sha}).strict();
export const Tier1ScopeQuerySchema=z.object({offset:z.coerce.number().int().min(0).max(10000).default(0),
 localLeagueId:CatalogIdSchema.optional(),at:z.iso.datetime({precision:3}).optional()}).strict();
export const Tier1ScopeContextSchema=z.object({localLeagueId:CatalogIdSchema.nullable(),providerLeagueId:CatalogIdSchema.nullable(),
 at:z.iso.datetime({precision:3}).nullable()}).strict();
export const Tier1ScopeListSchema=z.object({items:z.array(Tier1ScopeSavedSchema).max(20),hasMore:z.boolean(),
 context:Tier1ScopeContextSchema,source:z.literal('owner_reviewed_catalogue'),computedAt:z.iso.datetime({precision:6})}).strict();
export type Tier1Scope=z.infer<typeof Tier1ScopeSchema>;
export type Tier1ScopeSaved=z.infer<typeof Tier1ScopeSavedSchema>;
export function tier1ScopeMismatch(scope:Tier1Scope,context:z.infer<typeof Tier1ScopeContextSchema>):string|null{
 if(!context.localLeagueId||!context.providerLeagueId)return 'У лиги сценария не установлен ID OpenDota. Уточните турнир сценария.';
 if(scope.leagueId!==context.providerLeagueId)return 'ID OpenDota этого события не совпадает с лигой сценария.';
 if(!context.at)return 'У сценария не указано плановое начало карты.';
 if(context.at<scope.fromAt||context.at>=scope.until)return 'Начало карты находится вне периода выбранного события.';
 return null;
}
