import {createHash} from 'node:crypto';
import {sql} from 'kysely';
import {ProvisionBatchSchema,type ProvisionBatch,type AccountEvidence,type AliasEvidence} from '@dota/contracts';
import type {Db,Executor} from './index.js';
import {canonicalContextJson} from './temporal.js';
import {readAccountEvidence,appendAccountEvidenceInTransaction,appendAliasEvidence} from './identity-repository.js';
const hash=(value:unknown)=>createHash('sha256').update(canonicalContextJson(value)).digest('hex');
const compare=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
export function normalizeReviewedAccounts(input:unknown){
  const batch=ProvisionBatchSchema.parse(input);
  return {...batch,...(batch.policyVersion==='reviewed-current-catalogue-v1'?{teams:[...batch.teams].sort((a,b)=>compare(a.teamId,b.teamId))}:{}),
    accounts:[...batch.accounts].sort((a,b)=>compare(a.accountId,b.accountId))} as ProvisionBatch;
}
export function reviewedIdentityEvidence(batch:ProvisionBatch,account:ProvisionBatch['accounts'][number],playerId:string){
  const normalized=normalizeReviewedAccounts(batch),reviewSha256=hash(normalized);
  const clocks={eventAt:null,knownAt:batch.source.knownAt,fetchedAt:batch.source.fetchedAt,
    source:batch.policyVersion+':'+(batch.policyVersion==='reviewed-current-catalogue-v1'?batch.source.url:batch.source.archiveUrl),
    evidenceRef:`review-sha256:${reviewSha256};payload-sha256:${batch.source.payloadSha256};account:${account.accountId}`};
  const claim:AccountEvidence={playerId,provider:'opendota',externalAccountId:account.accountId,status:'verified',...clocks};
  const alias:AliasEvidence={playerId,alias:account.alias,...clocks};
  return {claim,alias,claimSha256:hash(claim),aliasSha256:hash(alias),reviewSha256};
}
export class IdentityProvisionError extends Error {
  constructor(readonly code:'identity_provision_conflict'|'identity_plan_stale'|'identity_inventory_overflow'|'identity_review_in_future'){
    super(code);this.name='IdentityProvisionError';
  }
}
type Player={id:string;opendota_account_id:string|null;steam64_id:string|null};
type Legacy={id:string;player_id:string;provider:string;external_account_id:string;link_status:string;evidence_ref:string|null;verified:boolean};
async function planOn(db:Executor,batch:ProvisionBatch){
  const accountIds=batch.accounts.map(a=>a.accountId),steamIds=batch.accounts.map(a=>a.steam64);
  const revision=(await sql<{revision:string}>`SELECT revision FROM identity_registry_state WHERE singleton=TRUE`.execute(db)).rows[0]!.revision;
  const claims=(await readAccountEvidence(db,accountIds)).sort((a,b)=>a.observationId.localeCompare(b.observationId));
  const legacy=(await sql<Legacy>`SELECT id,player_id,provider,external_account_id,link_status,evidence_ref,
    verified_at IS NOT NULL AS verified FROM player_external_accounts
    WHERE provider IN ('opendota','stratz') AND external_account_id=ANY(${accountIds}::text[]) ORDER BY id LIMIT 10001`.execute(db)).rows;
  const referenced=[...new Set([...claims.map(c=>c.playerId),...legacy.map(l=>l.player_id)])];
  const players=(await sql<Player>`SELECT id,opendota_account_id,steam64_id FROM players
    WHERE opendota_account_id=ANY(${accountIds}::bigint[]) OR steam64_id=ANY(${steamIds}::text[]) OR id=ANY(${referenced}::bigint[])
    ORDER BY id LIMIT 10001`.execute(db)).rows;
  const playerIds=players.map(p=>p.id);
  const aliases=(await sql<{id:string;evidence_sha256:string|null}>`SELECT id,evidence_sha256 FROM player_alias_history
    WHERE player_id=ANY(${playerIds}::bigint[]) ORDER BY id LIMIT 10001`.execute(db)).rows;
  if([claims,legacy,players,aliases].some(rows=>rows.length>10000))throw new IdentityProvisionError('identity_inventory_overflow');
  const rows=batch.accounts.map(account=>{
    const evidence=claims.filter(c=>c.externalAccountId===account.accountId),links=legacy.filter(l=>l.external_account_id===account.accountId);
    const ids=new Set([...players.filter(p=>p.opendota_account_id===account.accountId||p.steam64_id===account.steam64).map(p=>p.id),
      ...evidence.map(c=>c.playerId),...links.map(l=>l.player_id)]);
    const reasons:string[]=[];
    if(ids.size>1)reasons.push('MULTIPLE_CANONICAL_TARGETS');
    if(evidence.some(c=>c.status!=='verified')||links.some(l=>l.link_status!=='verified'||!l.verified||!l.evidence_ref?.trim()))
      reasons.push('UNRESOLVED_EXISTING_CLAIM');
    const playerId=ids.size===1?[...ids][0]!:null,target=players.find(p=>p.id===playerId);
    if(playerId!==null&&(!target||target.opendota_account_id!==null&&target.opendota_account_id!==account.accountId||
      target.steam64_id!==null&&target.steam64_id!==account.steam64))reasons.push('CANONICAL_NUMERIC_ID_MISMATCH');
    const proof=playerId===null?null:reviewedIdentityEvidence(batch,account,playerId);
    const accountEvidencePresent=proof!==null&&evidence.some(({observationId,...c})=>observationId.startsWith('proof:')&&hash(c)===proof.claimSha256);
    const aliasEvidencePresent=proof!==null&&aliases.some(a=>a.evidence_sha256===proof.aliasSha256);
    return {accountId:account.accountId,steam64:account.steam64,alias:account.alias,playerId,
      action:playerId===null?'create' as const:'reuse' as const,accountEvidencePresent,aliasEvidencePresent,reasons};
  });
  for(const row of rows)if(row.playerId!==null&&rows.filter(r=>r.playerId===row.playerId).length>1)row.reasons.push('DUPLICATE_CANONICAL_TARGET');
  const teams=batch.policyVersion==='reviewed-current-catalogue-v1'?batch.teams:[];
  const existingTeams=teams.length?(await sql<{id:string;opendota_team_id:string;name:string;tag:string|null;synced_at:Date|null}>`
    SELECT id,opendota_team_id,name,tag,synced_at FROM teams
    WHERE opendota_team_id=ANY(${teams.map(t=>t.teamId)}::bigint[]) ORDER BY id`.execute(db)).rows:[];
  const teamRows=teams.map(t=>{const existing=existingTeams.find(e=>e.opendota_team_id===t.teamId);
    return {...t,canonicalTeamId:existing?.id??null,action:existing?'reuse' as const:'create' as const,
      existingName:existing?.name??null,warnings:existing&&(existing.name!==t.name||existing.tag!==t.tag)?['EXISTING_TEAM_LABEL_PRESERVED']:[]};});
  const status=rows.some(r=>r.reasons.length)?'blocked' as const:
    rows.every(r=>r.accountEvidencePresent&&r.aliasEvidencePresent)&&teamRows.every(t=>t.action==='reuse')?'already_applied' as const:'ready' as const;
  return {policyVersion:batch.policyVersion,reviewSha256:hash(batch),identityRevision:revision,status,rows,
    fingerprint:hash({reviewSha256:hash(batch),revision,claims,legacy,players,aliases,...(teams.length?{existingTeams}:{})}),
    ...(teams.length?{teamRows,plannedTeams:teamRows.filter(t=>t.action==='create').length}:{}),
    plannedPlayers:rows.filter(r=>r.action==='create').length,plannedAccountProofs:rows.filter(r=>!r.accountEvidencePresent).length,
    plannedAliases:rows.filter(r=>!r.aliasEvidencePresent).length};
}
/** Bounded offline operation. Never merges people, mutates legacy links, or reconstructs map lineups. */
export class IdentityProvisioner {
  constructor(private readonly db:Db){}
  private batch(input:unknown){const b=normalizeReviewedAccounts(input);
    if(b.reviewedAt>new Date().toISOString())throw new IdentityProvisionError('identity_review_in_future');return b;}
  async preview(input:unknown){const batch=this.batch(input);
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
      await sql`SET TRANSACTION READ ONLY`.execute(tx);return planOn(tx,batch);
    });
  }
  async snapshot(input:unknown){const batch=this.batch(input);
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      const observations=(await readAccountEvidence(tx,batch.accounts.map(a=>a.accountId))).sort((a,b)=>a.observationId.localeCompare(b.observationId));
      const state=(await sql<{revision:string;observed_at:Date}>`SELECT revision,date_trunc('milliseconds',clock_timestamp()) AS observed_at
        FROM identity_registry_state WHERE singleton=TRUE`.execute(tx)).rows[0]!;
      return {observations,registryRevision:state.revision,observedAt:state.observed_at.toISOString()};
    });
  }
  async apply(input:unknown,expectedFingerprint:string){
    const batch=this.batch(input);if(!/^[a-f0-9]{64}$/.test(expectedFingerprint))throw new IdentityProvisionError('identity_plan_stale');
    return this.db.transaction().execute(async tx=>{
      await sql`SET LOCAL lock_timeout='5s'`.execute(tx);
      await sql`SET LOCAL statement_timeout='15s'`.execute(tx);
      // Same numeric lock order as the existing append boundary; protect legacy/numeric writers as well.
      for(const a of batch.accounts)await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:${a.accountId}`},0))`.execute(tx);
      await sql`LOCK TABLE teams,players,player_external_accounts,player_account_evidence,player_alias_history IN SHARE ROW EXCLUSIVE MODE`.execute(tx);
      const before=await planOn(tx,batch);
      if(before.status==='blocked')throw new IdentityProvisionError('identity_provision_conflict');
      if(before.status!=='already_applied'&&before.fingerprint!==expectedFingerprint)throw new IdentityProvisionError('identity_plan_stale');
      let playersCreated=0,accountProofsAdded=0,aliasesAdded=0,teamsCreated=0;
      if(batch.policyVersion==='reviewed-current-catalogue-v1')for(const t of before.teamRows??[]){
        if(t.action==='create'){
          await sql`INSERT INTO teams(opendota_team_id,name,tag,synced_at)
            VALUES (${t.teamId},${t.name},${t.tag},${t.source.fetchedAt})`.execute(tx);teamsCreated++;
        }
      }
      for(const row of before.rows){
        let playerId=row.playerId;
        if(playerId===null){
          playerId=(await sql<{id:string}>`INSERT INTO players(opendota_account_id,steam64_id,nickname,synced_at)
            VALUES (${row.accountId},${row.steam64},${row.alias},${batch.source.fetchedAt}) RETURNING id`.execute(tx)).rows[0]!.id;
          playersCreated++;
        }
        const {claim,alias}=reviewedIdentityEvidence(batch,row,playerId);
        if(!row.accountEvidencePresent){await appendAccountEvidenceInTransaction(tx,claim);accountProofsAdded++;}
        if(!row.aliasEvidencePresent){await appendAliasEvidence(tx,alias);aliasesAdded++;}
      }
      const after=await planOn(tx,batch);
      if(after.status!=='already_applied')throw new IdentityProvisionError('identity_provision_conflict');
      const observedAt=(await sql<{observed_at:Date}>`SELECT date_trunc('milliseconds',clock_timestamp()) AS observed_at`.execute(tx)).rows[0]!.observed_at.toISOString();
      return {status:before.status==='already_applied'?'already_applied' as const:'applied' as const,observedAt,
        playersCreated,accountProofsAdded,aliasesAdded,...(batch.policyVersion==='reviewed-current-catalogue-v1'?{teamsCreated}:{}),planBefore:before,planAfter:after};
    });
  }
}
