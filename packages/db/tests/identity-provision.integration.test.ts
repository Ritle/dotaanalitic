import {beforeAll,afterAll,it,expect} from 'vitest';
import {IdentityProvisioner,IdentityRepository,readAccountEvidence,resolveIdentity,sql,reviewedIdentityEvidence,normalizeReviewedAccounts} from '../src/index.js';
import type {ReviewedAccountBatch} from '@dota/contracts';
import {testDatabase} from '../../../tests/helpers/postgres.js';
let database:Awaited<ReturnType<typeof testDatabase>>,provisioner:IdentityProvisioner,identity:IdentityRepository;
const batch=(ids=['101','102']):ReviewedAccountBatch=>({schemaVersion:1,policyVersion:'reviewed-single-account-v1',reviewedAt:'2026-10-31T00:00:00.000Z',
  source:{reportSha256:'a'.repeat(64),mapSha256:'b'.repeat(64),payloadSha256:'c'.repeat(64),projectionSha256:'d'.repeat(64),
    archiveUrl:'https://web.archive.org/web/20230411210628id_/https://api.opendota.com/api/proPlayers?',
    knownAt:'2023-04-11T21:06:28.000Z',fetchedAt:'2026-10-30T00:00:00.000Z'},
  accounts:ids.map(accountId=>({accountId,steam64:String(76561197960265728n+BigInt(accountId)),alias:'Synthetic shared nickname'}))});
beforeAll(async()=>{database=await testDatabase();provisioner=new IdentityProvisioner(database.db);identity=new IdentityRepository(database.db);},30000);
afterAll(async()=>{await database?.close();});
async function counts(){return (await sql<{players:number;proofs:number;aliases:number;revision:string}>`SELECT
  (SELECT count(*)::int FROM players) AS players,(SELECT count(*)::int FROM player_account_evidence) AS proofs,
  (SELECT count(*)::int FROM player_alias_history) AS aliases,(SELECT revision FROM identity_registry_state) AS revision`.execute(database.db)).rows[0]!;}
it('preview writes nothing; apply creates distinct numeric identities, immutable proofs and aliases',async()=>{
  const b=batch(),before=await counts(),plan=await provisioner.preview(b);expect(await counts()).toEqual(before);
  expect(plan).toMatchObject({status:'ready',plannedPlayers:2,plannedAccountProofs:2,plannedAliases:2});
  const r=await provisioner.apply(b,plan.fingerprint);expect(r).toMatchObject({status:'applied',playersCreated:2,accountProofsAdded:2,aliasesAdded:2});
  expect(new Set(r.planAfter.rows.map(p=>p.playerId)).size).toBe(2);
  const evidence=await readAccountEvidence(database.db,['101','102']);
  expect(evidence).toHaveLength(2);expect(evidence.every(e=>e.eventAt===null&&e.knownAt===b.source.knownAt&&e.fetchedAt===b.source.fetchedAt)).toBe(true);
  expect(resolveIdentity(evidence,'101','2023-04-11T21:06:27.999Z').playerId).toBeNull();
  expect(resolveIdentity(evidence,'101','2023-10-12T17:00:44.000Z').status).toBe('verified');
  await expect(sql`DELETE FROM player_account_evidence WHERE external_account_id='101'`.execute(database.db)).rejects.toThrow(/immutable/i);
  expect((await sql<{n:string}>`SELECT count(*) AS n FROM player_external_accounts`.execute(database.db)).rows[0]!.n).toBe('0');
});
it('exact replay including reversed source order is idempotent after revision changes',async()=>{
  const b=batch(),before=await counts();b.accounts.reverse();
  const r=await provisioner.apply(b,'0'.repeat(64));expect(r.status).toBe('already_applied');
  expect(r.playersCreated+r.accountProofsAdded+r.aliasesAdded).toBe(0);expect(await counts()).toEqual(before);
  expect(normalizeReviewedAccounts(b).accounts[0]!.accountId).toBe('101');
});
it('post-apply snapshot reads canonical claims and revision without mutations',async()=>{
  const before=await counts(),snapshot=await provisioner.snapshot(batch());
  expect(snapshot.registryRevision).toBe(before.revision);expect(snapshot.observations).toHaveLength(2);
  expect(snapshot.observedAt).toMatch(/^\d{4}-\d\d-\d\dT/);expect(await counts()).toEqual(before);
});
it('concurrent apply creates one batch and the waiter reuses it',async()=>{
  const b=batch(['201','202']),plan=await provisioner.preview(b);
  const results=await Promise.all([provisioner.apply(b,plan.fingerprint),provisioner.apply(b,plan.fingerprint)]);
  expect(results.map(r=>r.status).sort()).toEqual(['already_applied','applied']);
  expect(results.reduce((n,r)=>n+r.playersCreated,0)).toBe(2);
});
it('reuses one exact numeric target without changing its display name or losing bigint precision',async()=>{
  const b=batch(['301']);await sql`INSERT INTO players(id,opendota_account_id,steam64_id,nickname)
    VALUES ('9007199254740993','301',${b.accounts[0]!.steam64},'Synthetic existing display')`.execute(database.db);
  const p=await provisioner.preview(b);expect(p.rows[0]!.playerId).toBe('9007199254740993');
  const r=await provisioner.apply(b,p.fingerprint);expect(r.playersCreated).toBe(0);expect(r.planAfter.rows[0]!.playerId).toBe('9007199254740993');
  expect((await sql<{nickname:string}>`SELECT nickname FROM players WHERE id='9007199254740993'`.execute(database.db)).rows[0]!.nickname).toBe('Synthetic existing display');
});
it('does not reuse an unrelated player with the same nickname',async()=>{
  await sql`INSERT INTO players(id,nickname) VALUES ('9007199254740994','Synthetic shared nickname')`.execute(database.db);
  const b=batch(['401']),p=await provisioner.preview(b);expect(p.rows[0]!.action).toBe('create');
  expect((await provisioner.apply(b,p.fingerprint)).planAfter.rows[0]!.playerId).not.toBe('9007199254740994');
});
it('rejects a stale plan when an exact numeric target appears after preview',async()=>{
  const b=batch(['501']),p=await provisioner.preview(b);
  await sql`INSERT INTO players(opendota_account_id,nickname) VALUES ('501','Synthetic new target')`.execute(database.db);
  const before=await counts();await expect(provisioner.apply(b,p.fingerprint)).rejects.toMatchObject({code:'identity_plan_stale'});
  expect(await counts()).toEqual(before);
});
it('blocks provisional/rejected claims and preserves the entire batch unchanged',async()=>{
  const b=batch(['601','602']);await sql`INSERT INTO players(id,nickname) VALUES ('9007199254740995','Synthetic candidate')`.execute(database.db);
  const proof=reviewedIdentityEvidence(b,b.accounts[1]!,'9007199254740995').claim;
  await identity.appendAccountEvidence({...proof,status:'provisional'});
  const p=await provisioner.preview(b),before=await counts();expect(p.status).toBe('blocked');
  await expect(provisioner.apply(b,p.fingerprint)).rejects.toMatchObject({code:'identity_provision_conflict'});expect(await counts()).toEqual(before);
  await identity.appendAccountEvidence({...proof,status:'rejected'});expect((await provisioner.preview(b)).status).toBe('blocked');
});
it('detects cross-provider contradictory targets and legacy provisional links omitted by normal readers',async()=>{
  const b=batch(['701']);await identity.appendAccountEvidence(reviewedIdentityEvidence(b,b.accounts[0]!,'9007199254740994').claim);
  await identity.appendAccountEvidence({...reviewedIdentityEvidence(b,b.accounts[0]!,'9007199254740995').claim,provider:'stratz'});
  expect((await provisioner.preview(b)).rows[0]!.reasons).toContain('MULTIPLE_CANONICAL_TARGETS');
  await sql`INSERT INTO player_external_accounts(player_id,provider,external_account_id,link_status)
    VALUES ('9007199254740994','opendota','702','provisional')`.execute(database.db);
  expect((await provisioner.preview(batch(['702']))).rows[0]!.reasons).toContain('UNRESOLVED_EXISTING_CLAIM');
});
it('rejects two accounts resolving to one person and inconsistent stored Steam64',async()=>{
  const b=batch(['801','802']);for(const a of b.accounts)await identity.appendAccountEvidence(reviewedIdentityEvidence(b,a,'9007199254740994').claim);
  expect((await provisioner.preview(b)).rows.every(r=>r.reasons.includes('DUPLICATE_CANONICAL_TARGET'))).toBe(true);
  await sql`INSERT INTO players(opendota_account_id,steam64_id,nickname) VALUES ('803','76561197960266532','Synthetic mismatch')`.execute(database.db);
  expect((await provisioner.preview(batch(['803']))).rows[0]!.reasons).toContain('CANONICAL_NUMERIC_ID_MISMATCH');
});
it('rolls back players, proofs, aliases and registry revision when a later append fails',async()=>{
  const b=batch(['901','902']);b.accounts[1]!.alias='Synthetic rejected alias';
  await sql`CREATE FUNCTION fail_test_alias() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.alias='Synthetic rejected alias' THEN RAISE EXCEPTION 'synthetic alias failure'; END IF; RETURN NEW; END; $$`.execute(database.db);
  await sql`CREATE TRIGGER fail_test_alias BEFORE INSERT ON player_alias_history FOR EACH ROW EXECUTE FUNCTION fail_test_alias()`.execute(database.db);
  try{const p=await provisioner.preview(b),before=await counts();await expect(provisioner.apply(b,p.fingerprint)).rejects.toThrow(/synthetic alias failure/);
    expect(await counts()).toEqual(before);
  }finally{await sql`DROP TRIGGER fail_test_alias ON player_alias_history`.execute(database.db);await sql`DROP FUNCTION fail_test_alias()`.execute(database.db);}
});
it('late contradictory evidence blocks replay instead of hiding a conflict',async()=>{
  const b=batch(['1001']),p=await provisioner.preview(b),r=await provisioner.apply(b,p.fingerprint);
  await identity.appendAccountEvidence({...reviewedIdentityEvidence(b,b.accounts[0]!,r.planAfter.rows[0]!.playerId!).claim,status:'rejected'});
  await expect(provisioner.apply(b,p.fingerprint)).rejects.toMatchObject({code:'identity_provision_conflict'});
});
it('rejects a future review before any DB write',async()=>{
  await expect(provisioner.preview({...batch(['1101']),reviewedAt:'2099-01-01T00:00:00.000Z'})).rejects.toMatchObject({code:'identity_review_in_future'});
});
