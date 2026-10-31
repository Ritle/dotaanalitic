import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AccountEvidence, ContextObservation } from '@dota/contracts';
import { IdentityRepository, MatchContextRepository, readAccountEvidence, resolveIdentity, sql } from '../src/index.js';
import { rosterCoplay } from '../../analytics/src/roster.js';
import { testDatabase } from '../../../tests/helpers/postgres.js';

let database:Awaited<ReturnType<typeof testDatabase>>;
let identity:IdentityRepository;
const cutoffAt='2024-01-01T12:00:00.000Z';
const five=['1','2','3','4','5'];
const proof=(playerId:string,externalAccountId:string,overrides:Partial<AccountEvidence>={}):AccountEvidence=>({
  playerId,externalAccountId,provider:'opendota',status:'verified',eventAt:'2023-01-01T00:00:00.000Z',
  knownAt:'2023-01-01T00:00:00.000Z',fetchedAt:'2026-10-31T00:00:00.000Z',source:'synthetic',evidenceRef:'synthetic:dated-account',...overrides
});
beforeAll(async()=>{
  database=await testDatabase();identity=new IdentityRepository(database.db);
  for(let i=1;i<=30;i++)await sql`INSERT INTO players(id,nickname) VALUES (${String(i)},'Synthetic identical nickname')`.execute(database.db);
  await sql`INSERT INTO players(id,nickname) VALUES ('9007199254740993','Synthetic identical nickname')`.execute(database.db);
  for(let i=1;i<=10;i++)await sql`INSERT INTO heroes(id,internal_name,localized_name) VALUES (${i},${'synthetic_'+i},${'Synthetic '+i})`.execute(database.db);
  await sql`INSERT INTO teams(id,name) VALUES (1,'Synthetic old organization'),(2,'Synthetic new organization')`.execute(database.db);
  for(let i=1;i<=20;i++)await identity.appendAccountEvidence(proof(String(i),String(1000+i)));
},30000);
afterAll(async()=>{await database?.close();});

async function map(id:string,startedAt:string,radiant:string[],dire:string[],options:{pro?:boolean|null;duration?:number|null;winner?:boolean|null;team?:string}={}){
  const pro=options.pro===undefined?true:options.pro,duration=options.duration===undefined?1800:options.duration;
  const winner=options.winner===undefined?true:options.winner;
  await sql`INSERT INTO matches(id,started_at,is_pro,duration_seconds,radiant_win,radiant_team_id,dire_team_id)
    VALUES (${id},${startedAt},${pro},${duration},${winner},${options.team??'1'},${options.team==='2'?'1':'2'})`.execute(database.db);
  for(const [i,playerId] of [...radiant,...dire].entries()){
    const slot=i<5?i:i+123;
    await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id,source_account_id)
      VALUES (${id},${slot},${i<5?'radiant':'dire'},${i+1},${String(1000+Number(playerId))})`.execute(database.db);
  }
}

it('same nickname and aliases never merge different canonical people; aliases retain source/time and dedupe',async()=>{
  const row={playerId:'28',alias:'Synthetic Alias',source:'synthetic',eventAt:null,knownAt:cutoffAt,
    fetchedAt:'2026-10-31T00:00:00.000Z',evidenceRef:'synthetic:alias'};
  const ids=await Promise.all([identity.appendAlias(row),identity.appendAlias(row)]);
  expect(ids[0]).toBe(ids[1]);
  await identity.appendAlias({...row,playerId:'29'});
  expect((await identity.aliasesAsOf('28',cutoffAt)).map(item=>item.playerId)).toEqual(['28']);
  expect((await identity.aliasesAsOf('29',cutoffAt)).map(item=>item.playerId)).toEqual(['29']);
  expect(await identity.aliasesAsOf('28','2024-01-01T11:59:59.999Z')).toEqual([]);
  await identity.appendAlias({...row,alias:'Synthetic Later Alias',knownAt:'2025-01-01T00:00:00.000Z'});
  expect(await identity.aliasesAsOf('28',cutoffAt)).toHaveLength(1);
  await expect(sql`DELETE FROM player_alias_history WHERE id=${ids[0]!}`.execute(database.db)).rejects.toThrow(/immutable/i);
});

it('proof append is idempotent, immutable and preserves bigints; concurrent providers cannot choose a winner',async()=>{
  const before=(await sql<{revision:string}>`SELECT revision FROM identity_registry_state`.execute(database.db)).rows[0]!.revision;
  const row=proof('9007199254740993','9001');
  const entries=await Promise.all(Array.from({length:4},()=>identity.appendAccountEvidence(row)));
  expect(new Set(entries.map(item=>item.observationId)).size).toBe(1);
  expect(entries[0]!.resolution.playerId).toBe('9007199254740993');
  const after=(await sql<{revision:string}>`SELECT revision FROM identity_registry_state`.execute(database.db)).rows[0]!.revision;
  expect(BigInt(after)-BigInt(before)).toBe(1n);
  await expect(sql`UPDATE player_account_evidence SET player_id=29 WHERE external_account_id='9001'`.execute(database.db)).rejects.toThrow(/immutable/i);
  await Promise.all([identity.appendAccountEvidence(proof('28','9002')),identity.appendAccountEvidence(proof('29','9002',{provider:'stratz'}))]);
  const evidence=await readAccountEvidence(database.db,['9002']);
  expect(resolveIdentity(evidence,'9002',cutoffAt)).toMatchObject({playerId:null,status:'conflict'});
  expect(evidence).toHaveLength(2);
});

it('legacy current verification and later proof never silently backdate identity',async()=>{
  await sql`INSERT INTO player_external_accounts(player_id,provider,external_account_id,link_status,evidence_ref)
    VALUES (29,'opendota','9004','provisional','')`.execute(database.db);
  expect(await readAccountEvidence(database.db,['9004'])).toEqual([]);
  await sql`INSERT INTO player_external_accounts(player_id,provider,external_account_id,link_status,evidence_ref,verified_at)
    VALUES (28,'opendota','9003','verified','synthetic:legacy',now())`.execute(database.db);
  let evidence=await readAccountEvidence(database.db,['9003']);
  expect(resolveIdentity(evidence,'9003',null).playerId).toBe('28');
  expect(resolveIdentity(evidence,'9003',cutoffAt).playerId).toBeNull();
  await identity.appendAccountEvidence(proof('28','9003',{knownAt:'2025-01-01T00:00:00.000Z'}));
  evidence=await readAccountEvidence(database.db,['9003']);
  expect(resolveIdentity(evidence,'9003',cutoffAt).playerId).toBeNull();
  await identity.appendAccountEvidence(proof('28','9003'));
  expect(resolveIdentity(await readAccountEvidence(database.db,['9003']),'9003',cutoffAt).playerId).toBe('28');
});

it('personal history and exact/pair coplay survive transfers, side swaps and a later full organization reshuffle',async()=>{
  await map('101','2023-12-01T10:00:00.000Z',five,['11','12','13','14','15']);
  await map('102','2023-12-02T10:00:00.000Z',['11','12','13','14','15'],five);
  await map('103','2023-12-03T10:00:00.000Z',['6','7','8','9','10'],['11','12','13','14','15']);
  const history=await identity.historyForPlayers({playerIds:five,cutoffAt});
  expect(history.cohort).toBe('retrospective_participation');
  expect(history.nRaw).toBe(2);
  expect(history.players.every(player=>player.mapCount===2)).toBe(true);
  expect(history.sides.map(side=>side.teamId)).toEqual(['1','2']);
  const sides=history.sides.filter(side=>side.complete).map(side=>({matchId:side.matchId,startedAtMs:Date.parse(side.startedAt),side:side.side,
    playerIds:side.players.map(player=>player.playerId!)}));
  expect(rosterCoplay(five,sides,Date.parse(cutoffAt))).toMatchObject({exactFiveMaps:2,pairMaps:{'1:2':2}});
  expect(rosterCoplay(['1','2','3','4','6'],sides,Date.parse(cutoffAt))).toMatchObject({exactFiveMaps:0,pairMaps:{'1:2':2,'1:6':0}});
  expect(rosterCoplay(['6','7','8','9','10'],sides,Date.parse(cutoffAt)).exactFiveMaps).toBe(0);
  const next=await identity.historyForPlayers({playerIds:['6','7','8','9','10'],cutoffAt});
  expect(next.sides.map(side=>side.matchId)).toEqual(['103']);
  // No retroactive rewriting of match_players IDs when identity proof is registered later.
  expect((await sql<{count:string}>`SELECT count(*) FROM match_players WHERE player_id IS NOT NULL`.execute(database.db)).rows[0]!.count).toBe('0');
});

it('history excludes future, equal cutoff, public, unknown-pro and unfinished maps',async()=>{
  const opponent=['11','12','13','14','15'];
  await map('104','2024-01-02T00:00:00.000Z',five,opponent);
  await map('105',cutoffAt,five,opponent);
  await map('106','2023-12-04T00:00:00.000Z',five,opponent,{pro:false});
  await map('107','2023-12-05T00:00:00.000Z',five,opponent,{pro:null});
  await map('108','2023-12-06T00:00:00.000Z',five,opponent,{duration:null,winner:null});
  await map('109','2024-01-01T11:59:00.000Z',five,opponent);
  const history=await identity.historyForPlayers({playerIds:['1'],cutoffAt});
  expect(history.sides.map(side=>side.matchId)).toEqual(['101','102']);
  expect(history.players[0]?.mapCount).toBe(2);
  expect(JSON.stringify(history)).not.toContain('radiant_win');
});

it('zero observed maps and unverified identity are different, even for an existing canonical player',async()=>{
  await identity.appendAccountEvidence(proof('21','9021',{status:'provisional'}));
  const history=await identity.historyForPlayers({playerIds:['20','21'],cutoffAt});
  expect(history.players).toEqual([{playerId:'20',status:'verified',mapCount:0},{playerId:'21',status:'unknown',mapCount:null}]);
  expect(history.warnings).toContain('UNKNOWN_IDENTITY_HISTORY');
});

it('same canonical person on two source accounts in one map is not a valid five',async()=>{
  await identity.appendAccountEvidence(proof('16','9016'));
  await map('110','2023-12-10T10:00:00.000Z',['16','17','18','19','20'],['11','12','13','14','15']);
  await sql`UPDATE match_players SET source_account_id=9016 WHERE match_id=110 AND player_slot=1`.execute(database.db);
  const history=await identity.historyForPlayers({playerIds:['18'],cutoffAt});
  expect(history.sides[0]?.complete).toBe(false);
  expect(history.sides[0]?.players.slice(0,2).map(player=>player.playerId)).toEqual([null,null]);
  expect(history.warnings).toContain('DUPLICATE_CANONICAL_PLAYER');
  expect((await identity.historyForPlayers({playerIds:['16'],cutoffAt})).players[0]?.mapCount).toBeNull();
});

it('a future identity contradiction cannot alter the earlier historical participation cohort',async()=>{
  const before=await identity.historyForPlayers({playerIds:['1'],cutoffAt});
  await identity.appendAccountEvidence(proof('29','1001',{provider:'stratz',knownAt:'2025-01-01T00:00:00.000Z'}));
  const after=await identity.historyForPlayers({playerIds:['1'],cutoffAt});
  expect(after.sides).toEqual(before.sides);
  expect(after.players).toEqual(before.players);
  expect(BigInt(after.identityRevision)).toBeGreaterThan(BigInt(before.identityRevision));
  expect(resolveIdentity(await readAccountEvidence(database.db,['1001']),'1001',null).status).toBe('conflict');
});

it('lineup as-of uses proved map slots and role evidence, never current roster flags',async()=>{
  await sql`INSERT INTO matches(id,started_at) VALUES (200,${cutoffAt})`.execute(database.db);
  await sql`INSERT INTO team_roster_periods(team_id,player_id,role_pos,source,verified,known_at)
    VALUES (1,1,1,'opendota',true,'2023-01-01T00:00:00Z')`.execute(database.db);
  const request={matchId:'200',cutoffAt,stage:'pre_match' as const};
  expect((await identity.lineupAsOf(request)).lineup?.sides.every(side=>!side.complete)).toBe(true);
  const contextRepo=new MatchContextRepository(database.db);
  const slots=Array.from({length:10},(_,i)=>({playerSlot:i<5?i:i+123,playerId:String(i+1)}));
  const row=(fact:ContextObservation['fact']):ContextObservation=>({matchId:'200',fact,eventAt:null,knownAt:cutoffAt,
    fetchedAt:'2026-10-31T00:00:00.000Z',availability:'verified_asof',earliestStage:'pre_match',provider:'synthetic',
    providerRecordId:null,evidenceRef:'synthetic:announced-five',adapterVersion:'test',reviewState:'accepted'});
  await contextRepo.append(row({field:'lineup',value:slots}));
  await contextRepo.append(row({field:'roles',value:slots.map((slot,i)=>({...slot,rolePos:i%5+1,basis:i===0?'estimated':'confirmed',confidence:i===0?0.2:1}))}));
  const result=await identity.lineupAsOf(request);
  expect(result.lineup?.sides.every(side=>side.complete)).toBe(true);
  expect(result.lineup?.sides[0]?.players[0]).toMatchObject({playerId:'1',rolePos:null,roleEvidence:{rolePos:1,confidence:0.2}});
  expect(result.lineup?.sides[1]?.rolesConfirmed).toBe(true);
  expect(result.lineup?.dataRevision).toBe('2');
  expect((await identity.lineupAsOf({...request,cutoffAt:'2024-01-01T11:59:59.999Z'})).lineup?.sides.every(side=>!side.complete)).toBe(true);
});

it('SQL guards reject forged proof, microsecond backdating and nonexistent canonical players',async()=>{
  await expect(sql`INSERT INTO player_account_evidence(player_id,provider,external_account_id,link_status,source,fetched_at,evidence_sha256)
    VALUES (28,'opendota','9028','verified','synthetic',${cutoffAt},${'a'.repeat(64)})`.execute(database.db)).rejects.toThrow();
  await expect(sql`INSERT INTO player_account_evidence(player_id,provider,external_account_id,link_status,source,fetched_at,known_at,evidence_ref,evidence_sha256)
    VALUES (28,'opendota','9028','verified','synthetic','2026-10-31T00:00:00Z','2024-01-01T12:00:00.000001Z','synthetic',${'a'.repeat(64)})`.execute(database.db)).rejects.toThrow();
  await expect(identity.appendAccountEvidence(proof('9999999','9028'))).rejects.toThrow(/foreign key/i);
});

it('two explicitly verified accounts preserve one canonical career across different maps',async()=>{
  await identity.appendAccountEvidence(proof('30','9030'));
  await identity.appendAccountEvidence(proof('30','9031'));
  for(const [matchId,account] of [['112','9030'],['113','9031']] as const){
    await map(matchId,'2023-12-15T10:00:00.000Z',['30','17','18','19','20'],['11','12','13','14','15']);
    await sql`UPDATE match_players SET source_account_id=${account} WHERE match_id=${matchId} AND player_slot=0`.execute(database.db);
  }
  const history=await identity.historyForPlayers({playerIds:['30'],cutoffAt});
  expect(history.players).toEqual([{playerId:'30',status:'verified',mapCount:2}]);
  expect(history.sides.every(side=>side.complete && side.players[0]?.playerId==='30')).toBe(true);
});

it('missing native slot produces partial lineup, never a fabricated fifth member',async()=>{
  await map('114','2023-12-16T10:00:00.000Z',['16','17','18','19','20'],['11','12','13','14','15']);
  await sql`DELETE FROM match_players WHERE match_id=114 AND player_slot=4`.execute(database.db);
  const history=await identity.historyForPlayers({playerIds:['18'],cutoffAt});
  expect(history.sides.find(side=>side.matchId==='114')).toMatchObject({complete:false});
  expect(history.sides.find(side=>side.matchId==='114')?.players).toHaveLength(4);
  expect(history.warnings).toContain('INCOMPLETE_LINEUP');
});
