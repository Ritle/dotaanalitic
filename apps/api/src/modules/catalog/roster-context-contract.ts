import {z} from 'zod';
import {CatalogIdSchema,Steam32Schema} from '@dota/contracts';

// Client-safe presentation contract, shared with the web app. Not a prediction feature contract.
const Identity=z.enum(['verified','unknown','conflict']);
const Team=z.object({id:CatalogIdSchema.nullable(),providerTeamId:CatalogIdSchema,name:z.string().nullable()}).strict();
export const RosterContextSchema=z.object({
 schemaVersion:z.literal(1),kind:z.enum(['teams','players']),entityId:CatalogIdSchema,computedAt:z.iso.datetime(),
 status:z.enum(['listed','not_listed','identity_unresolved','team_unlinked','source_missing']),canRefresh:z.boolean(),
 source:z.object({provider:z.literal('opendota'),endpoint:z.literal('/proPlayers'),status:z.enum(['ready','stale','not_loaded','unavailable']),
  fetchedAt:z.iso.datetime().nullable(),payloadSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),eventAt:z.null(),knownAt:z.null(),refreshFailed:z.boolean()}).strict(),
 identityStatus:Identity.nullable(),accountId:Steam32Schema.nullable(),team:Team.nullable(),
 members:z.array(z.object({accountId:Steam32Schema,playerId:CatalogIdSchema.nullable(),name:z.string(),localName:z.string().nullable(),identityStatus:Identity,team:Team.nullable()}).strict()).max(10000)
}).strict();
export type RosterContext=z.infer<typeof RosterContextSchema>;
