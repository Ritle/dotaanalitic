import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CurrentAccountSelectionSchema,ReviewedCurrentAccountsSchema,IdentityTimeSchema} from '@dota/contracts';
import {ProPlayersSchema} from './schemas.js';
const Capture=z.object({schemaVersion:z.literal(1),mode:z.literal('current_catalogue_capture'),
  registry:z.object({rawBody:z.string().max(16*1024*1024),source:z.object({provider:z.literal('opendota'),
    endpoint:z.literal('/proPlayers'),fetchedAt:IdentityTimeSchema,knownAt:z.null(),payloadSha256:z.string().regex(/^[a-f0-9]{64}$/)})})});
/** Raw numeric registry evidence only. Teams, namesakes and recent-member flags never select identity. */
export function prepareCurrentAccounts(input:unknown,reportSha256:string,selectionInput:unknown){
  const capture=Capture.parse(input),selection=CurrentAccountSelectionSchema.parse(selectionInput),observation=capture.registry;
  if(createHash('sha256').update(observation.rawBody).digest('hex')!==observation.source.payloadSha256)
    throw new Error('accounts_source_binding');
  const registry=ProPlayersSchema.parse(JSON.parse(observation.rawBody) as unknown);
  const accounts=[...selection.accountIds].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1).map(accountId=>{
    const rows=registry.filter(p=>p.account_id===accountId);
    if(!rows.length)throw new Error('account_selection_missing');
    if(rows.length!==1)throw new Error('account_selection_ambiguous');
    const row=rows[0]!;
    if(!row.steamid||!row.name?.trim())throw new Error('account_evidence_incomplete');
    return {accountId,steam64:row.steamid,alias:row.name.trim()};
  });
  const review=ReviewedCurrentAccountsSchema.parse({schemaVersion:1,policyVersion:'reviewed-current-accounts-v1',reviewedAt:selection.reviewedAt,
    source:{reportSha256,payloadSha256:observation.source.payloadSha256,url:'https://api.opendota.com/api/proPlayers',
      knownAt:observation.source.fetchedAt,fetchedAt:observation.source.fetchedAt},accounts});
  return {review,sourceRowCount:registry.length,warnings:['CURRENT_ACCOUNT_IDENTITY_ONLY','NO_MEMBERSHIP_OR_LINEUP_ASSERTION','NO_HISTORICAL_BACKDATE']};
}
