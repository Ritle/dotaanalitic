import {z} from 'zod';
import {CatalogIdSchema as Id} from './catalog.js';
import {Steam32Schema} from './identity.js';
const Sha=z.string().regex(/^[a-f0-9]{64}$/),Time=z.iso.datetime({precision:3});
export const RosterCatalogueSearchSchema=z.object({kind:z.enum(['teams','players']),query:z.string().trim().min(1).max(200)}).strict();
export const RosterCatalogueCandidateSchema=z.object({id:Id,name:z.string().max(256),teamId:Id.nullable(),teamName:z.string().max(256).nullable()}).strict();
export const RosterCatalogueSearchResultSchema=z.object({items:z.array(RosterCatalogueCandidateSchema).max(25),source:z.literal('opendota'),fetchedAt:Time,payloadSha256:Sha}).strict();
const Pair=z.object({providerPlayerId:Id,accountId:Steam32Schema}).strict();
export const RosterCatalogueApplySchema=z.object({requestId:z.uuid(),providerTeamId:Id,teamId:Id,expectedRevision:z.number().int().nonnegative(),
 rosterSha256:Sha,registrySha256:Sha,players:z.array(Pair).length(5),confirmedByOwner:z.literal(true)}).strict().superRefine((v,c)=>{
 if(new Set(v.players.map(p=>p.providerPlayerId)).size!==5||new Set(v.players.map(p=>p.accountId)).size!==5)c.addIssue({code:'custom',message:'Five distinct players required'});
});
export const RosterCatalogueBindingSchema=z.object({providerTeamId:Id,teamId:Id,teamName:z.string(),revision:z.number().int().positive(),recordedAt:Time,
 players:z.array(Pair.extend({playerId:Id,name:z.string(),proMaps:z.number().int().nonnegative(),identityStatus:z.enum(['verified','unknown','conflict'])})).length(5),
 source:z.object({provider:z.literal('opendota'),fetchedAt:Time,payloadSha256:Sha,rosterFetchedAt:Time,rosterSha256:Sha}),usable:z.boolean()}).strict();
export const RosterCatalogueStateSchema=z.object({matchId:Id,rosterSha256:Sha.nullable(),rosterFetchedAt:Time.nullable(),
 teams:z.array(z.object({providerTeamId:Id,name:z.string().nullable(),players:z.array(z.object({providerPlayerId:Id,name:z.string().nullable()})).max(30),binding:RosterCatalogueBindingSchema.nullable()})).max(2)}).strict();
export type RosterCatalogueApply=z.infer<typeof RosterCatalogueApplySchema>;
export type RosterCatalogueState=z.infer<typeof RosterCatalogueStateSchema>;
export type RosterCatalogueBinding=z.infer<typeof RosterCatalogueBindingSchema>;
export type RosterCatalogueCandidate=z.infer<typeof RosterCatalogueCandidateSchema>;
