import {z} from 'zod';
import {Steam32Schema,IdentityTimeSchema,CanonicalPlayerIdSchema} from './identity.js';
const Sha=z.string().regex(/^[a-f0-9]{64}$/);
/** Trusted, reviewed numeric evidence only. Never accepted directly from a provider or HTTP endpoint. */
export const ReviewedAccountBatchSchema=z.object({
  schemaVersion:z.literal(1),policyVersion:z.literal('reviewed-single-account-v1'),reviewedAt:IdentityTimeSchema,
  source:z.object({reportSha256:Sha,mapSha256:Sha,payloadSha256:Sha,projectionSha256:Sha,
    archiveUrl:z.string().regex(/^https:\/\/web\.archive\.org\/web\/\d{14}id_\/https:\/\/api\.opendota\.com\/api\/proPlayers\??$/),
    knownAt:IdentityTimeSchema,fetchedAt:IdentityTimeSchema}).strict(),
  accounts:z.array(z.object({accountId:Steam32Schema,steam64:z.string().regex(/^\d{17}$/),
    alias:z.string().trim().min(1).max(120)}).strict()).min(1).max(10)
}).strict().superRefine((batch,ctx)=>{
  if(batch.source.knownAt>batch.source.fetchedAt||batch.source.fetchedAt>batch.reviewedAt)
    ctx.addIssue({code:'custom',message:'Review clocks out of order'});
  if(new Set(batch.accounts.map(a=>a.accountId)).size!==batch.accounts.length||
    batch.accounts.some(a=>BigInt(a.steam64)!==76561197960265728n+BigInt(a.accountId)))
    ctx.addIssue({code:'custom',message:'Duplicate or inconsistent numeric account'});
});
export type ReviewedAccountBatch=z.infer<typeof ReviewedAccountBatchSchema>;

/** Separate current-observation policy. No historical availability is inferred. */
export const ReviewedCurrentCatalogueSchema=z.object({
  schemaVersion:z.literal(1),policyVersion:z.literal('reviewed-current-catalogue-v1'),reviewedAt:IdentityTimeSchema,
  source:z.object({reportSha256:Sha,payloadSha256:Sha,url:z.literal('https://api.opendota.com/api/proPlayers'),
    knownAt:IdentityTimeSchema,fetchedAt:IdentityTimeSchema}).strict(),
  accounts:z.array(z.object({accountId:Steam32Schema,steam64:z.string().regex(/^\d{17}$/),
    alias:z.string().trim().min(1).max(120)}).strict()).min(1).max(100),
  teams:z.array(z.object({teamId:CanonicalPlayerIdSchema,name:z.string().trim().min(1).max(256),tag:z.string().max(64).nullable(),
    source:z.object({endpoint:z.string(),payloadSha256:Sha,fetchedAt:IdentityTimeSchema}).strict()
  }).strict()).min(1).max(20)
}).strict().superRefine((b,ctx)=>{
  if(b.source.knownAt!==b.source.fetchedAt||b.source.fetchedAt>b.reviewedAt||
    b.teams.some(t=>t.source.fetchedAt>b.reviewedAt||t.source.endpoint!==`/teams/${t.teamId}`))
    ctx.addIssue({code:'custom',message:'Current observation clocks or endpoint invalid'});
  if(new Set(b.accounts.map(a=>a.accountId)).size!==b.accounts.length||
    new Set(b.teams.map(t=>t.teamId)).size!==b.teams.length||
    b.accounts.some(a=>BigInt(a.steam64)!==76561197960265728n+BigInt(a.accountId)))
    ctx.addIssue({code:'custom',message:'Duplicate or inconsistent numeric ID'});
});
export type ReviewedCurrentCatalogue=z.infer<typeof ReviewedCurrentCatalogueSchema>;
export const ProvisionBatchSchema=z.union([ReviewedAccountBatchSchema,ReviewedCurrentCatalogueSchema]);
export type ProvisionBatch=z.infer<typeof ProvisionBatchSchema>;
