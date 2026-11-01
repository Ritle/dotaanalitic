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
/** Explicit account selection is independent of a provider's current organization membership. */
export const CurrentAccountSelectionSchema=z.object({accountIds:z.array(Steam32Schema).min(1).max(100),reviewedAt:IdentityTimeSchema})
  .strict().refine(s=>new Set(s.accountIds).size===s.accountIds.length,'Duplicate account selection');
export const ReviewedCurrentAccountsSchema=z.object({
  schemaVersion:z.literal(1),policyVersion:z.literal('reviewed-current-accounts-v1'),reviewedAt:IdentityTimeSchema,
  source:z.object({reportSha256:Sha,payloadSha256:Sha,url:z.literal('https://api.opendota.com/api/proPlayers'),
    knownAt:IdentityTimeSchema,fetchedAt:IdentityTimeSchema}).strict(),
  accounts:z.array(z.object({accountId:Steam32Schema,steam64:z.string().regex(/^\d{17}$/),
    alias:z.string().trim().min(1).max(120)}).strict()).min(1).max(100)
}).strict().superRefine((b,ctx)=>{
  if(b.source.knownAt!==b.source.fetchedAt||b.source.fetchedAt>b.reviewedAt)
    ctx.addIssue({code:'custom',message:'Current observation clocks invalid'});
  if(new Set(b.accounts.map(a=>a.accountId)).size!==b.accounts.length||
    b.accounts.some(a=>BigInt(a.steam64)!==76561197960265728n+BigInt(a.accountId)))
    ctx.addIssue({code:'custom',message:'Duplicate or inconsistent numeric ID'});
});
export type ReviewedCurrentAccounts=z.infer<typeof ReviewedCurrentAccountsSchema>;
/** A profile is a current numeric account anchor, never pro status or a map lineup. */
export const ReviewedCurrentProfileSchema=z.object({
  schemaVersion:z.literal(1),policyVersion:z.literal('reviewed-current-profile-v1'),reviewedAt:IdentityTimeSchema,
  source:z.object({reportSha256:Sha,payloadSha256:Sha,
    url:z.string().regex(/^https:\/\/api\.opendota\.com\/api\/players\/[1-9]\d*$/),
    knownAt:IdentityTimeSchema,fetchedAt:IdentityTimeSchema}).strict(),
  accounts:ReviewedCurrentAccountsSchema.shape.accounts.length(1)
}).strict().superRefine((b,ctx)=>{
  const a=b.accounts[0];
  if(b.source.knownAt!==b.source.fetchedAt||b.source.fetchedAt>b.reviewedAt)
    ctx.addIssue({code:'custom',message:'Current profile clocks invalid'});
  if(!a||b.source.url!==`https://api.opendota.com/api/players/${a.accountId}`||BigInt(a.steam64)!==76561197960265728n+BigInt(a.accountId))
    ctx.addIssue({code:'custom',message:'Inconsistent profile account binding'});
});
export type ReviewedCurrentProfile=z.infer<typeof ReviewedCurrentProfileSchema>;
export const ProvisionBatchSchema=z.union([ReviewedAccountBatchSchema,ReviewedCurrentCatalogueSchema,ReviewedCurrentAccountsSchema,ReviewedCurrentProfileSchema]);
export type ProvisionBatch=z.infer<typeof ProvisionBatchSchema>;
