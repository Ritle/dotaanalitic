import {z} from 'zod';
import {CatalogIdSchema as Id} from './catalog.js';
import {Steam32Schema} from './identity.js';
const Sha=z.string().regex(/^[a-f0-9]{64}$/),Time=z.iso.datetime({precision:3});
export const RosterCatalogueSearchSchema=z.object({kind:z.enum(['teams','players']),query:z.string().trim().min(1).max(200)}).strict();
export const RosterCataloguePrepareSchema=z.object({externalSearch:z.boolean().optional()}).strict();
export const RosterCatalogueCandidateSchema=z.object({id:Id,name:z.string().max(256),teamId:Id.nullable(),teamName:z.string().max(256).nullable(),provider:z.enum(['opendota','pandascore']).optional(),profileSha256:Sha.optional(),
 localPlayerId:Id.optional(),discovery:z.boolean().optional(),reason:z.string().max(256).optional(),aliases:z.array(z.string().max(256)).max(30).optional(),proMaps:z.number().int().nonnegative().optional(),observedAt:Time.optional()}).strict();
export const RosterCatalogueSearchResultSchema=z.object({items:z.array(RosterCatalogueCandidateSchema).max(25),source:z.enum(['opendota','local']),fetchedAt:Time,payloadSha256:Sha,
 sourceEndpoint:z.string().max(1000).optional(),registrySha256:Sha.nullable().optional(),warning:z.enum(['source_unavailable','external_search_deferred']).optional()}).strict();
const Pair=z.object({providerPlayerId:Id,accountId:Steam32Schema,profileSha256:Sha.optional(),localPlayerId:Id.optional(),linkToken:Sha.optional()}).strict();
export const RosterCatalogueApplySchema=z.object({requestId:z.uuid(),providerTeamId:Id,teamId:Id,teamProvider:z.enum(['opendota','pandascore']).optional(),expectedRevision:z.number().int().nonnegative(),
 rosterSha256:Sha,registrySha256:Sha.nullable(),players:z.array(Pair).length(5),confirmedByOwner:z.literal(true)}).strict().superRefine((v,c)=>{
 if(new Set(v.players.map(p=>p.providerPlayerId)).size!==5||new Set(v.players.map(p=>p.accountId)).size!==5)c.addIssue({code:'custom',message:'Five distinct players required'});
});
export const RosterCatalogueBindingSchema=z.object({providerTeamId:Id,teamId:Id,teamName:z.string(),revision:z.number().int().positive(),recordedAt:Time,
 players:z.array(Pair.extend({playerId:Id,name:z.string(),proMaps:z.number().int().nonnegative(),identityStatus:z.enum(['verified','unknown','conflict'])})).length(5),
 source:z.object({provider:z.enum(['opendota','local']),fetchedAt:Time,payloadSha256:Sha,rosterFetchedAt:Time,rosterSha256:Sha,
  team:z.object({provider:z.enum(['opendota','pandascore']),externalTeamId:Id,fetchedAt:Time,payloadSha256:Sha}).optional(),
  profiles:z.array(z.object({accountId:Steam32Schema,fetchedAt:Time,payloadSha256:Sha})).max(5).optional(),localCards:z.array(RosterCatalogueCandidateSchema).max(5).optional()}),usable:z.boolean()}).strict();
export const RosterCatalogueStateSchema=z.object({matchId:Id,rosterSha256:Sha.nullable(),rosterFetchedAt:Time.nullable(),
 teams:z.array(z.object({providerTeamId:Id,name:z.string().nullable(),players:z.array(z.object({providerPlayerId:Id,name:z.string().nullable(),linkToken:Sha.optional()})).max(30),binding:RosterCatalogueBindingSchema.nullable()})).max(2)}).strict();
export type RosterCatalogueApply=z.infer<typeof RosterCatalogueApplySchema>;
export type RosterCatalogueState=z.infer<typeof RosterCatalogueStateSchema>;
export type RosterCatalogueBinding=z.infer<typeof RosterCatalogueBindingSchema>;
export type RosterCatalogueCandidate=z.infer<typeof RosterCatalogueCandidateSchema>;
export const RosterCataloguePreparedPlayerSchema=z.object({providerPlayerId:Id,name:z.string().nullable(),linkToken:Sha,
 status:z.enum(['linked','suggested','ambiguous','not_found','source_unavailable','conflict']),reason:z.enum(['external_search_deferred','source_unavailable']).optional(),candidates:z.array(RosterCatalogueCandidateSchema).max(25)}).strict();
export const RosterCataloguePreparedSchema=z.object({matchId:Id,rosterSha256:Sha.nullable(),registrySha256:Sha.nullable(),preparedAt:Time,
 teams:z.array(z.object({providerTeamId:Id,players:z.array(RosterCataloguePreparedPlayerSchema).max(30)})).max(2)}).strict();
export type RosterCataloguePrepared=z.infer<typeof RosterCataloguePreparedSchema>;
