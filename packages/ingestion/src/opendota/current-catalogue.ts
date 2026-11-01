import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ReviewedCurrentCatalogueSchema,IdentityTimeSchema} from '@dota/contracts';
import {ProPlayersSchema,TeamSchema,ProviderIdSchema} from './schemas.js';
const Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Observation=z.object({rawBody:z.string().max(16*1024*1024),source:z.object({provider:z.literal('opendota'),
  endpoint:z.string(),fetchedAt:IdentityTimeSchema,knownAt:z.null(),payloadSha256:Sha})});
const Capture=z.object({schemaVersion:z.literal(1),mode:z.literal('current_catalogue_capture'),
  registry:Observation,teams:z.array(Observation).min(1).max(20)}).strict();
const sha=(body:string)=>createHash('sha256').update(body).digest('hex');
function payload(observation:z.infer<typeof Observation>,endpoint:string){
  if(observation.source.endpoint!==endpoint||sha(observation.rawBody)!==observation.source.payloadSha256)
    throw new Error('catalogue_source_binding');
  return JSON.parse(observation.rawBody) as unknown;
}
/** Replay raw provider bytes, then project selected numeric organizations. No nickname joins. */
export function prepareCurrentCatalogue(input:unknown,reportSha256:string,reviewedAt:string){
  const capture=Capture.parse(input),registry=ProPlayersSchema.parse(payload(capture.registry,'/proPlayers'));
  const teams=capture.teams.map(o=>{
    const team=TeamSchema.parse(JSON.parse(o.rawBody));ProviderIdSchema.parse(team.team_id);
    payload(o,`/teams/${team.team_id}`);
    if(!team.name?.trim())throw new Error('catalogue_team_name_missing');
    return {teamId:team.team_id,name:team.name.trim(),tag:team.tag??null,
      source:{endpoint:o.source.endpoint,payloadSha256:o.source.payloadSha256,fetchedAt:o.source.fetchedAt}};
  });
  const ids=new Set(teams.map(t=>t.teamId));
  if(ids.size!==teams.length)throw new Error('catalogue_duplicate_team');
  const selected=registry.filter(p=>p.team_id!=null&&ids.has(p.team_id));
  const accounts=selected.map(p=>{
    // Both numeric IDs must actually be supplied by the provider; do not fill a missing Steam64.
    if(!p.steamid||!p.name?.trim())throw new Error('catalogue_account_incomplete');
    return {accountId:p.account_id,steam64:p.steamid,alias:p.name.trim()};
  });
  const review=ReviewedCurrentCatalogueSchema.parse({schemaVersion:1,policyVersion:'reviewed-current-catalogue-v1',reviewedAt,
    source:{reportSha256,payloadSha256:capture.registry.source.payloadSha256,url:'https://api.opendota.com/api/proPlayers',
      knownAt:capture.registry.source.fetchedAt,fetchedAt:capture.registry.source.fetchedAt},accounts,teams});
  return {review,sourceRowCount:registry.length,reportedMemberships:selected.map(p=>({accountId:p.account_id,
    reportedTeamId:p.team_id,reportedTeamName:p.team_name??null,reportedPro:p.is_pro??null,reportedLocked:p.is_locked??null})),
    warnings:['CURRENT_CATALOGUE_ONLY','MEMBERSHIP_IS_NOT_MAP_LINEUP','NO_PROVIDER_IDENTITY_JOIN','NO_HISTORICAL_BACKDATE']};
}
