import {beforeAll,afterAll,it,expect} from 'vitest';
import {IdentityProvisioner,IdentityRepository,readAccountEvidence,resolveIdentity,sql,reviewedIdentityEvidence,normalizeReviewedAccounts} from '../src/index.js';
import {ReviewedCurrentCatalogueSchema,ReviewedCurrentAccountsSchema,type ReviewedAccountBatch,type ReviewedCurrentCatalogue} from '@dota/contracts';
import {testDatabase} from '../../../tests/helpers/postgres.js';
let database:Awaited<ReturnType<typeof testDatabase>>,provisioner:IdentityProvisioner,identity:IdentityRepository;
const batch=(ids=['101','102']):ReviewedAccountBatch=>({schemaVersion:1,policyVersion:'reviewed-single-account-v1',reviewedAt:'2026-10-31T00:00:00.000Z',
  source:{reportSha256:'a'.repeat(64),mapSha256:'b'.repeat(64),payloadSha256:'c'.repeat(64),projectionSha256:'d'.repeat(64),
    archiveUrl:'https://web.archive.org/web/20230411210628id_/https://api.opendota.com/api/proPlayers?',
    knownAt:'2023-04-11T21:06:28.000Z',fetchedAt:'2026-10-30T00:00:00.000Z'},
  accounts:ids.map(accountId=>({accountId,steam64:String(76561197960265728n+BigInt(accountId)),alias:'Synthetic shared nickname'}))});
const current=(id='2101',team='3101'):ReviewedCurrentCatalogue=>({schemaVersion:1,policyVersion:'reviewed-current-catalogue-v1',
  reviewedAt:'2026-10-31T00:00:00.000Z',source:{reportSha256:'a'.repeat(64),payloadSha256:'b'.repeat(64),
    url:'https://api.opendota.com/api/proPlayers',knownAt:'2026-10-30T00:00:00.000Z',fetchedAt:'2026-10-30T00:00:00.000Z'},
  accounts:batch([id]).accounts,teams:[{teamId:team,name:'Synthetic current organization',tag:'TEST',
    source:{endpoint:`/teams/${team}`,payloadSha256:'c'.repeat(64),fetchedAt:'2026-10-30T00:00:00.000Z'}}]});
beforeAll(async()=>{database=await testDatabase();provisioner=new IdentityProvisioner(database.db);identity=new IdentityRepository(database.db);},30000);
afterAll(async()=>{await database?.close();});
it('selected current accounts add no organizations, keep namesakes distinct and never become historical lineup evidence',async()=>{
  const {teams,...base}=current('2201');
  const b=ReviewedCurrentAccountsSchema.parse({...base,policyVersion:'reviewed-current-accounts-v1',accounts:batch(['2201','2202']).accounts});
  const teamCount=async()=>(await sql`SELECT count(*)::int AS n FROM teams`.execute(database.db)).rows;
  const beforeTeams=await teamCount(),before=await counts(),p=await provisioner.preview(b);expect(await counts()).toEqual(before);
  expect(p).toMatchObject({status:'ready',plannedPlayers:2});
  const r=await provisioner.apply(b,p.fingerprint);expect(r).toMatchObject({playersCreated:2,accountProofsAdded:2,aliasesAdded:2});
  expect(new Set(r.planAfter.rows.map(row=>row.playerId)).size).toBe(2);expect(await teamCount()).toEqual(beforeTeams);
  expect(await provisioner.apply(b,p.fingerprint)).toMatchObject({status:'already_applied',playersCreated:0,accountProofsAdded:0,aliasesAdded:0});
  const proof=await readAccountEvidence(database.db,['2201']);expect(resolveIdentity(proof,'2201',null).playerId).not.toBeNull();
  expect(resolveIdentity(proof,'2201','2026-10-29T23:59:59.999Z').playerId).toBeNull();
  expect(proof[0]).toMatchObject({eventAt:null,knownAt:b.source.fetchedAt});
  expect(ReviewedCurrentAccountsSchema.safeParse({...b,source:{...b.source,knownAt:'2023-01-01T00:00:00.000Z'}}).success).toBe(false);
});
it('current account selection cannot bypass a conflicting existing claim or create the rest of the batch',async()=>{
  const {teams,...base}=current('2203');
  const b=ReviewedCurrentAccountsSchema.parse({...base,policyVersion:'reviewed-current-accounts-v1',accounts:batch(['2203','2204']).accounts});
  const existing=(await sql<{id:string}>`SELECT id::text FROM players ORDER BY id LIMIT 1`.execute(database.db)).rows[0]!;
  await identity.appendAccountEvidence({...reviewedIdentityEvidence(b,b.accounts[0]!,existing.id).claim,status:'rejected'});
  const p=await provisioner.preview(b),before=await counts();expect(p.status).toBe('blocked');
  await expect(provisioner.apply(b,p.fingerprint)).rejects.toMatchObject({code:'identity_provision_conflict'});expect(await counts()).toEqual(before);
});
it('current catalogue adds organizations and account anchors atomically, replay adds nothing, no historical coverage',async()=>{
  const b=current(),p=await provisioner.preview(b);expect(p).toMatchObject({status:'ready',plannedTeams:1,plannedPlayers:1});
  expect((await sql<{n:number}>`SELECT count(*)::int AS n FROM teams`.execute(database.db)).rows[0]!.n).toBe(0);
  const r=await provisioner.apply(b,p.fingerprint);expect(r).toMatchObject({teamsCreated:1,playersCreated:1,accountProofsAdded:1});
  expect((await provisioner.apply(b,p.fingerprint))).toMatchObject({status:'already_applied',teamsCreated:0,playersCreated:0,accountProofsAdded:0,aliasesAdded:0});
  const proof=await readAccountEvidence(database.db,['2101']);expect(resolveIdentity(proof,'2101','2023-01-01T00:00:00.000Z').playerId).toBeNull();
  expect(proof[0]).toMatchObject({eventAt:null,knownAt:b.source.fetchedAt,fetchedAt:b.source.fetchedAt});
});
it('current preview cannot backdate knownAt or accept mismatched Steam IDs',()=>{
  const b=current();expect(ReviewedCurrentCatalogueSchema.safeParse({...b,source:{...b.source,knownAt:'2023-01-01T00:00:00.000Z'}}).success).toBe(false);
  expect(ReviewedCurrentCatalogueSchema.safeParse({...b,accounts:[{...b.accounts[0],steam64:'76561197960265728'}]}).success).toBe(false);
});
it('current import preserves existing team identity and display labels even for a changed source label',async()=>{
  const b=current('2102');const p=await provisioner.preview(b);expect(p.teamRows?.[0]).toMatchObject({action:'reuse'});
  b.teams[0]!.name='Synthetic renamed source';const next=await provisioner.preview(b);
  expect(next.teamRows?.[0]!.warnings).toContain('EXISTING_TEAM_LABEL_PRESERVED');
  expect((await provisioner.apply(b,next.fingerprint)).teamsCreated).toBe(0);
  expect((await sql<{name:string}>`SELECT name FROM teams WHERE opendota_team_id='3101'`.execute(database.db)).rows[0]!.name).toBe('Synthetic current organization');
});
it('a team appearing after preview makes the whole current batch stale',async()=>{
  const b=current('2103','3103'),p=await provisioner.preview(b);
  await sql`INSERT INTO teams(opendota_team_id,name) VALUES ('3103','Synthetic concurrent team')`.execute(database.db);
  const before=await counts();await expect(provisioner.apply(b,p.fingerprint)).rejects.toMatchObject({code:'identity_plan_stale'});expect(await counts()).toEqual(before);
});
it('current identity conflict blocks creation of its organization and preserves all rows',async()=>{
  const b=current('2104','3104');await identity.appendAccountEvidence({...reviewedIdentityEvidence(b,b.accounts[0]!,'1').claim,status:'rejected'});
  const p=await provisioner.preview(b),before=await counts();expect(p.status).toBe('blocked');
  await expect(provisioner.apply(b,p.fingerprint)).rejects.toMatchObject({code:'identity_provision_conflict'});expect(await counts()).toEqual(before);
  expect((await sql<{n:number}>`SELECT count(*)::int AS n FROM teams WHERE opendota_team_id='3104'`.execute(database.db)).rows[0]!.n).toBe(0);
});
it('a late alias failure rolls back the current organization as well as accounts',async()=>{
  const b=current('2105','3105');b.accounts[0]!.alias='Synthetic current failure';
  await sql`CREATE FUNCTION fail_current_alias() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.alias='Synthetic current failure' THEN RAISE EXCEPTION 'synthetic current failure'; END IF; RETURN NEW; END; $$`.execute(database.db);
  await sql`CREATE TRIGGER fail_current_alias BEFORE INSERT ON player_alias_history FOR EACH ROW EXECUTE FUNCTION fail_current_alias()`.execute(database.db);
  try {const p=await provisioner.preview(b),before=await counts();await expect(provisioner.apply(b,p.fingerprint)).rejects.toThrow(/synthetic current failure/);
    expect(await counts()).toEqual(before);expect((await sql<{n:number}>`SELECT count(*)::int AS n FROM teams WHERE opendota_team_id='3105'`.execute(database.db)).rows[0]!.n).toBe(0);
  }finally{await sql`DROP TRIGGER fail_current_alias ON player_alias_history`.execute(database.db);await sql`DROP FUNCTION fail_current_alias()`.execute(database.db);}
});
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
