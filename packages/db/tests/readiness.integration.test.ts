import { afterAll, beforeAll, expect, it } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { DataReadinessRepository, GameRegistryRepository, MatchContextRepository, sql } from '../src/index.js';
import type { ContextObservation, ReadinessRequest, StoredContextObservation } from '@dota/contracts';
import { request, observations, retrospective, registry, knownPlayers, start, snapshotAt } from './readiness-fixtures.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let reader: DataReadinessRepository;
let context: MatchContextRepository;
let nextId = 9007199254740993n;
beforeAll(async () => {
  database = await testDatabase(); reader = new DataReadinessRepository(database.db); context = new MatchContextRepository(database.db);
  for (const id of knownPlayers) await sql`INSERT INTO players(id,nickname) VALUES (${id},'Synthetic readiness')`.execute(database.db);
  await sql`INSERT INTO patches(id,label,released_at) VALUES (1,'synthetic-readiness',${'2024-01-01T00:00:00.000Z'})`.execute(database.db);
  const { id: _id, ...patch } = registry().patches[0]!;
  await new GameRegistryRepository(database.db).appendPatch(patch);
}, 30000);
afterAll(async () => { await database?.close(); }, 30000);
async function map() {
  const id = String(nextId++);
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro) VALUES (${id},${start},1800,true,true)`.execute(database.db);
  return id;
}
async function append(matchId: string, rows: StoredContextObservation[]) {
  for (const { id: _id, recordedAt: _recordedAt, ...row } of rows) await context.append({ ...row, matchId });
}
const query = (matchId: string, overrides: Partial<ReadinessRequest> = {}): ReadinessRequest => ({ ...request, matchId, ...overrides });

it('preserves clocks and labels reconstructed lineup as conditional while strict stays incomplete', async () => {
  const matchId = await map(); await append(matchId, retrospective());
  const strict = await reader.assess(query(matchId));
  expect(strict.assessment).toMatchObject({ status: 'incomplete', missingFacts: ['lineup','teams'] });
  const conditional = await reader.assess(query(matchId,{ cohort: 'conditional_lineup_reconstructed', assumedFacts: ['lineup','teams'] }));
  expect(conditional.assessment).toMatchObject({ status: 'ready', evidenceBasis: 'retrospective_conditional', dataRevision: '4',
    registryRevision: '1', trainingEligibility: 'not_assessed', predictionEligibility: 'not_assessed' });
  const fact = conditional.assessment?.fields.find(field=>field.field==='lineup');
  expect(fact?.evidence[0]).toMatchObject({ availability: 'retrospective_fact', knownAt: null, fetchedAt: snapshotAt, earliestStage: 'post_match' });
  expect((await new MatchContextRepository(database.db).readAsOf({matchId,cutoffAt:start,stage:'pre_match'})).context?.fields.every(row=>row.fact===null)).toBe(true);
  const text = JSON.stringify(conditional);
  expect(text).not.toContain('radiant_win');expect(text).not.toContain('duration_seconds');
});
it('existing completed-map canonical roster never supplies an implicit pre-known lineup', async () => {
  const matchId = await map();
  for (let i=0;i<10;i++) {
    await sql`INSERT INTO heroes(id,internal_name,localized_name) VALUES (${i+1},${'synthetic_readiness_'+i},'Synthetic') ON CONFLICT DO NOTHING`.execute(database.db);
    await sql`INSERT INTO match_players(match_id,player_slot,side,player_id,hero_id) VALUES (${matchId},${i<5?i:i+123},
      ${i<5?'radiant':'dire'},${knownPlayers[i]},${i+1})`.execute(database.db);
  }
  const result = await reader.assess(query(matchId,{requiredFacts:['lineup']}));
  expect(result.assessment?.missingFacts).toEqual(['lineup']);
  expect(result.assessment?.fields.find(row=>row.field==='lineup')?.fact).toBeNull();
});
it('accepted dated archives can supply strict facts, including patch registry proof', async () => {
  const matchId = await map(); await append(matchId, observations());
  const result = await reader.assess(query(matchId));
  expect(result.assessment).toMatchObject({ status:'ready',evidenceBasis:'verified_historical',appliedAssumptions:[],dataRevision:'4' });
  expect(result.assessment?.fields.find(row=>row.field==='patch')).toMatchObject({fact:{field:'patch',value:'1'},availability:'verified_asof'});
  const prior = await reader.assess(query(matchId,{snapshotAt:'2026-10-31T11:59:59.999Z'}));
  expect(prior.assessment?.status).toBe('incomplete');
});
it('owner entries require a pre-cutoff recording and never enter strict evaluation', async () => {
  const before = await map(), late = await map();
  const owner = observations().map(row=>({...row,provider:'owner',availability:'user_asserted_asof' as const,fetchedAt:start}));
  await append(before,owner); await append(late,owner.map(row=>({...row,fetchedAt:snapshotAt})));
  const profile = {cohort:'owner_asserted_asof' as const,requiredFacts:['lineup' as const]};
  expect((await reader.assess(query(before,profile))).assessment?.status).toBe('incomplete');
  expect((await reader.assess(query(before,{requiredFacts:['lineup']}))).assessment?.status).toBe('incomplete');
  expect((await reader.assess(query(late,profile))).assessment?.status).toBe('incomplete');
  const futureMap = await map();
  const futureStart = new Date(Date.now()+3600000).toISOString();
  await sql`UPDATE matches SET started_at=${futureStart},radiant_win=NULL,duration_seconds=NULL WHERE id=${futureMap}`.execute(database.db);
  await append(futureMap,owner);
  // The server stamp is an upper millisecond bound; let that conservative bound pass.
  await new Promise(resolve=>setTimeout(resolve,2));
  const recordedCutoff = new Date().toISOString();
  const live = await reader.assess(query(futureMap,{...profile,cutoffAt:recordedCutoff,snapshotAt:recordedCutoff}));
  expect(live.assessment?.status).toBe('ready');
  expect(live.assessment?.fields.find(row=>row.field==='lineup')?.evidence[0]?.recordedAt).not.toBeNull();
});

it('SQL cannot forge or rewrite the server recording stamp', async () => {
  const matchId=await map();
  const {rows}=await sql<{id:string;recorded_at:Date}>`INSERT INTO match_field_observations(match_id,field_name,provider,value,
    fetched_at,adapter_version,value_sha256,recorded_at) VALUES (${matchId},'synthetic-clock','owner','null',${start},
    'synthetic-v1',${'0'.repeat(64)},${start}) RETURNING id,recorded_at`.execute(database.db);
  expect(rows[0]!.recorded_at.toISOString()>start).toBe(true);
  await expect(sql`UPDATE match_field_observations SET recorded_at=${start} WHERE id=${rows[0]!.id}`.execute(database.db)).rejects.toThrow(/immutable/i);
});
it('hypothetical conditional data is explicit and still requires complete canonical identities and heroes', async () => {
  const matchId = await map(); await append(matchId,retrospective());
  const profile: Partial<ReadinessRequest> = {stage:'post_draft',cohort:'conditional_lineup_reconstructed',requiredFacts:['lineup','heroes'],assumedFacts:['lineup','heroes']};
  expect((await reader.assess(query(matchId,profile))).assessment?.status).toBe('ready');
  const other = await map(); const rows = retrospective();
  const lineup = rows.find(row=>row.fact.field==='lineup')!;
  if (lineup.fact.field==='lineup') lineup.fact.value![0]!.playerId='8888888888888888';
  await append(other,rows);
  expect((await reader.assess(query(other,profile))).assessment?.missingFacts).toContain('lineup');
});
it('availability reads are read-only and a late correction cannot alter selected strict values', async () => {
  const matchId = await map(); await append(matchId,observations());
  const original = await reader.assess(query(matchId));
  const correction: ContextObservation = {...observations()[1]!,matchId,fact:{field:'teams',value:{radiantTeamId:'22',direTeamId:'11'}},knownAt:'2025-01-01T00:00:00.000Z'};
  const { id:_id,...proof } = correction as ContextObservation & {id?:string};
  await context.append(proof);
  const result = await reader.assess(query(matchId));
  expect(result.assessment?.fields.find(row=>row.field==='teams')?.fact).toEqual(original.assessment?.fields.find(row=>row.field==='teams')?.fact);
  expect(result.assessment?.dataRevision).toBe('5');
  await reader.assess(query(matchId));
  expect((await sql<{data_revision:string}>`SELECT data_revision FROM matches WHERE id=${matchId}`.execute(database.db)).rows[0]!.data_revision).toBe('5');
});
it('missing/conflicting maps, post-start cutoff and future snapshots fail closed', async () => {
  expect((await reader.assess(query('777'))).reason).toBe('MAP_NOT_FOUND');
  const matchId = await map();
  expect((await reader.assess(query(matchId,{cutoffAt:'2024-01-01T12:00:00.001Z'}))).reason).toBe('CUTOFF_AFTER_MAP_START');
  expect((await reader.assess(query(matchId,{snapshotAt:'2099-01-01T00:00:00.000Z'}))).reason).toBe('SNAPSHOT_IN_FUTURE');
  await sql`UPDATE matches SET ingest_state='conflict' WHERE id=${matchId}`.execute(database.db);
  expect((await reader.assess(query(matchId))).reason).toBe('MAP_CONFLICT');
});
it('completion is checked in SQL before JS can round a future microsecond into the snapshot', async () => {
  const matchId = await map();
  await sql`UPDATE matches SET started_at='2024-01-01T12:00:00.000001Z' WHERE id=${matchId}`.execute(database.db);
  const result = await reader.assess(query(matchId,{snapshotAt:'2024-01-01T12:30:00.000Z',cohort:'conditional_lineup_reconstructed',assumedFacts:['lineup']}));
  expect(result.assessment?.blockers).toContain('MAP_NOT_COMPLETED_AT_SNAPSHOT');
});
