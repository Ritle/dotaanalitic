import {afterEach,beforeEach,expect,it} from 'vitest';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {GameRegistryRepository,PatchMetaRepository,PatchHistoryRepository,sql} from '../src/index.js';
import {patchRegistry,weightRequest,proof,release,old} from './patch-fixtures.js';
let database:Awaited<ReturnType<typeof testDatabase>>,writer:PatchMetaRepository,reader:PatchHistoryRepository;
beforeEach(async()=>{
  database=await testDatabase();writer=new PatchMetaRepository(database.db);reader=new PatchHistoryRepository(database.db);
  await sql`INSERT INTO patches(id,label,released_at) VALUES (1,'synthetic-old',${old}),(2,'synthetic-new',${release})`.execute(database.db);
  await sql`INSERT INTO heroes(id,internal_name,localized_name) VALUES (1,'synthetic','Synthetic')`.execute(database.db);
  const r=patchRegistry(),games=new GameRegistryRepository(database.db);
  for(const {id:_id,...p} of r.patches)await games.appendPatch(p);
  for(const {id:_id,...p} of r.heroRules)await games.appendHeroRule(p);
},30000);
afterEach(async()=>{await database?.close();});
async function seed(){const r=patchRegistry(),{id:_t,...transition}=r.transitions[0]!,{id:_h,...impact}=r.heroImpacts[0]!;
  return {transition,impact,transitionId:await writer.appendTransition(transition),impactId:await writer.appendHeroImpact(impact)};}
it('round trips reviewed patch and hero facts with one registry revision in the weight snapshot',async()=>{
  const seeded=await seed(),r=await reader.readAsOf(weightRequest());
  expect(r).toMatchObject({status:'computed_candidate',registryRevision:'6',deployable:false,teamAWinProbability:null});
  expect(r.maps[0]?.weight).toBe(0);expect(r.maps[0]?.proofIds).toContain('impact:'+seeded.impactId);
  const snapshot=await writer.snapshot();expect(snapshot.heroImpacts[0]).toMatchObject(proof);
});
it('idempotent concurrent writes bump revision only once per unique fact',async()=>{
  const {transition,impact,transitionId}=await seed();
  const ids=await Promise.all(Array.from({length:5},()=>writer.appendTransition(transition)));expect(new Set(ids)).toEqual(new Set([transitionId]));
  await writer.appendHeroImpact(impact);expect((await writer.snapshot()).revision).toBe('6');
});
it('append-only corrections invalidate cache keys but do not relabel late knowledge as early',async()=>{
  const {impact}=await seed(),before=await reader.readAsOf(weightRequest());
  await writer.appendHeroImpact({...impact,impactLevel:'unchanged',knownAt:'2024-01-04T00:00:00.000Z',evidenceRef:'synthetic:late-correction'});
  const after=await reader.readAsOf(weightRequest());expect(after.cacheKey).not.toBe(before.cacheKey);expect(after.maps[0]?.weight).toBe(0);expect(before.registryRevision).toBe('6');
  await writer.appendHeroImpact({...impact,impactLevel:'unchanged',evidenceRef:'synthetic:early-conflict'});
  expect((await reader.readAsOf(weightRequest())).maps[0]?.reasons).toContain('HERO_IMPACT_CONFLICT');
  for(const table of ['patch_transition_evidence','hero_impact_evidence']){
    await expect(sql`UPDATE ${sql.table(table)} SET source='changed'`.execute(database.db)).rejects.toThrow(/immutable/i);
    await expect(sql`DELETE FROM ${sql.table(table)}`.execute(database.db)).rejects.toThrow(/immutable/i);
  }
});
it('legacy mutable hero impacts are not accepted evidence and cannot override unknown',async()=>{
  await sql`INSERT INTO patch_hero_impacts(patch_id,hero_id,impact_level,source_url) VALUES (2,1,'rework','synthetic:legacy')`.execute(database.db);
  const {id:_id,...transition}=patchRegistry().transitions[0]!;await writer.appendTransition(transition);
  expect((await reader.readAsOf(weightRequest())).maps[0]?.reasons).toContain('HERO_IMPACT_UNKNOWN');
});
it('foreign keys, independent clocks and millisecond precision are enforced also in direct SQL',async()=>{
  const {impact}=await seed();await expect(writer.appendHeroImpact({...impact,heroId:999})).rejects.toThrow(/foreign key/i);
  await expect(writer.appendHeroImpact({...impact,knownAt:'2027-01-01T00:00:00.000Z'})).rejects.toThrow();
  await expect(sql`INSERT INTO hero_impact_evidence(patch_id,hero_id,impact_level,event_at,known_at,fetched_at,source,evidence_ref,review_state,evidence_sha256)
    VALUES (2,1,'minor',${release},'2024-01-01T00:00:00.000001Z',${proof.fetchedAt},'synthetic','synthetic:microseconds','accepted',${'c'.repeat(64)})`.execute(database.db)).rejects.toThrow(/check constraint/i);
});
