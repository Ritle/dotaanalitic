import {z} from 'zod';
import {CatalogIdSchema as Id} from './catalog.js';
import {RoleSuggestionReportSchema,RoleSuggestionRequestSchema} from './role-suggestions.js';
const Time=z.iso.datetime({precision:3}),Role=z.number().int().min(1).max(5);
export const RoleProfileBindingSchema=z.object({stratzTeamId:Id.nullable(),pandaTournamentId:Id.nullable(),pandaTeamId:Id.nullable(),
  pandaPlayers:z.array(z.object({playerId:Id,providerPlayerId:Id}).strict()).max(10)}).strict().superRefine((v,c)=>{
  if(v.stratzTeamId&&BigInt(v.stratzTeamId)>2147483647n)c.addIssue({code:'custom',message:'Invalid STRATZ team ID'});
  if((v.pandaTournamentId===null)!==(v.pandaTeamId===null))c.addIssue({code:'custom',message:'Both Panda team and tournament required'});
  if(v.pandaPlayers.length&&!v.pandaTeamId)c.addIssue({code:'custom',message:'Panda context required'});
  if(new Set(v.pandaPlayers.map(p=>p.playerId)).size!==v.pandaPlayers.length||new Set(v.pandaPlayers.map(p=>p.providerPlayerId)).size!==v.pandaPlayers.length)
    c.addIssue({code:'custom',message:'Duplicate role binding'});
});
export const RoleProfileBindingWriteSchema=z.object({requestId:z.uuid(),expectedRevision:z.number().int().nonnegative(),binding:RoleProfileBindingSchema,
  confirmedByOwner:z.literal(true)}).strict();
export const RoleProfileBindingSavedSchema=z.object({teamId:Id,revision:z.number().int().nonnegative(),recordedAt:Time.nullable(),binding:RoleProfileBindingSchema});
export const RoleProfilesRequestSchema=RoleSuggestionRequestSchema.safeExtend({teamId:Id,refreshProfiles:z.boolean().default(false)});
export const RoleProfileObservationSchema=z.object({provider:z.enum(['stratz','pandascore']),sourceKey:z.string().max(120),
  fetchedAt:Time,knownAt:z.null(),eventAt:z.null(),payloadSha256:z.string().regex(/^[a-f0-9]{64}$/),
  players:z.array(z.object({accountId:Id.nullable(),providerPlayerId:Id,providerTeamId:Id.nullable(),name:z.string().max(200).nullable(),roles:z.array(Role).max(5)})).max(3000)});
export const RoleProfilesReportSchema=z.object({policyVersion:z.literal('role-profile-consensus-v1'),snapshotAt:Time,teamId:Id,
  configured:z.object({enabled:z.boolean(),stratz:z.boolean(),pandascore:z.boolean()}),binding:RoleProfileBindingSavedSchema,
  history:RoleSuggestionReportSchema,
  sources:z.array(z.object({provider:z.enum(['stratz','pandascore']),sourceKey:z.string().max(120),status:z.enum(['ready','stale','unavailable']),reason:z.string().nullable(),
    fetchedAt:Time.nullable(),observation:RoleProfileObservationSchema.nullable()})),
  players:z.array(z.object({playerId:Id,accountIds:z.array(Id),identityStatus:z.enum(['verified','unknown','conflict']),
    rolePos:Role.nullable(),basis:z.enum(['agreement','profile_only','history_fallback','unknown','conflict']),autoEligible:z.boolean(),
    historyRole:Role.nullable(),historyMaps:z.number().int().nonnegative(),historyScope:z.enum(['selected_team','all_organizations']),
    candidates:z.array(z.object({source:z.enum(['stratz','pandascore','pro_history']),roles:z.array(Role),eligible:z.boolean(),reason:z.string().nullable()})),
    reasons:z.array(z.string())})).max(5),
  canAutoApply:z.boolean(),warnings:z.array(z.string())});
export const StratzRolePayloadSchema=z.object({errors:z.array(z.object({message:z.string().optional()})).optional(),data:z.object({player:z.object({
  steamAccountId:z.number().int().positive().max(4294967295),steamAccount:z.object({proSteamAccount:z.object({
    id:z.number().int().positive().max(4294967295),name:z.string().max(200).nullable(),teamId:z.number().int().positive().nullable(),
    position:z.string().max(40).nullable()}).nullable()}).nullable()}).nullable()}).nullable().optional()});
export const PandaRolePayloadSchema=z.object({type:z.literal('Team'),rosters:z.array(z.object({id:z.union([Id,z.number().int().positive().safe()]).transform(String),
  name:z.string().max(200).nullable(),players:z.array(z.object({id:z.union([Id,z.number().int().positive().safe()]).transform(String),
    name:z.string().max(200).nullable(),role:z.string().max(40).nullable().optional()})).max(30)})).max(100)});
export const parsePandaRoles=(role:string|null|undefined):number[]=>role&&/^[1-5](\/[1-5])*$/.test(role)?[...new Set(role.split('/').map(Number))].sort():[];
export type RoleProfileBinding=z.infer<typeof RoleProfileBindingSchema>;
export type RoleProfileObservation=z.infer<typeof RoleProfileObservationSchema>;
export type RoleProfilesReport=z.infer<typeof RoleProfilesReportSchema>;
export type RoleProfilesRequest=z.infer<typeof RoleProfilesRequestSchema>;
