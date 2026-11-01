import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CurrentAccountSelectionSchema,ReviewedCurrentProfileSchema,IdentityTimeSchema,Steam32Schema} from '@dota/contracts';
import {PlayerSchema} from './schemas.js';
const Capture=z.object({schemaVersion:z.literal(1),mode:z.literal('current_profile_capture'),accountId:Steam32Schema,
  observation:z.object({rawBody:z.string().max(1024*1024),source:z.object({provider:z.literal('opendota'),endpoint:z.string(),
    fetchedAt:IdentityTimeSchema,knownAt:z.null(),payloadSha256:z.string().regex(/^[a-f0-9]{64}$/)})})});
const DisplayProfile=z.object({profile:z.object({steamid:z.string().regex(/^\d{17}$/),
  name:z.string().max(256).nullish(),personaname:z.string().max(256).nullish()})});
export function prepareCurrentProfile(input:unknown,reportSha256:string,selectionInput:unknown){
  const capture=Capture.parse(input),selection=CurrentAccountSelectionSchema.parse(selectionInput),observation=capture.observation;
  if(selection.accountIds.length!==1||selection.accountIds[0]!==capture.accountId||observation.source.endpoint!==`/players/${capture.accountId}`||
    createHash('sha256').update(observation.rawBody).digest('hex')!==observation.source.payloadSha256)throw new Error('profile_source_binding');
  const raw:unknown=JSON.parse(observation.rawBody),identity=PlayerSchema.parse(raw);
  if(identity.profile?.account_id!==capture.accountId)throw new Error('profile_account_mismatch');
  const {profile}=DisplayProfile.parse(raw),alias=profile.name?.trim()||profile.personaname?.trim();
  if(!alias)throw new Error('profile_alias_missing');
  const review=ReviewedCurrentProfileSchema.parse({schemaVersion:1,policyVersion:'reviewed-current-profile-v1',reviewedAt:selection.reviewedAt,
    source:{reportSha256,payloadSha256:observation.source.payloadSha256,url:`https://api.opendota.com/api/players/${capture.accountId}`,
      knownAt:observation.source.fetchedAt,fetchedAt:observation.source.fetchedAt},
    accounts:[{accountId:capture.accountId,steam64:profile.steamid,alias}]});
  return {review,warnings:['CURRENT_ACCOUNT_IDENTITY_ONLY','PROFILE_IS_NOT_PRO_OR_LINEUP_PROOF','NO_HISTORICAL_BACKDATE']};
}
