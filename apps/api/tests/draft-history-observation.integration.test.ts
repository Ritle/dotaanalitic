import {beforeAll,afterAll,test,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedDraft,draftInput} from '../../../tests/helpers/draft.js';
import {ScenarioRepository,sql,registrySha,registryHash} from '@dota/db';
import {OpenDotaClient,IngestionService} from '@dota/ingestion';
import {AuthService} from '../src/modules/auth/service.js';
import {DraftCaptureRepository} from '../src/modules/scenarios/draft-capture-repository.js';
import {DraftHistoryRepository} from '../src/modules/scenarios/draft-history-repository.js';
import {DraftHistoryEvidenceSchema} from '../src/modules/scenarios/draft-history-contract.js';
let database:Awaited<ReturnType<typeof testDatabase>>,owner:string;
const matchId='9007199254743990';
beforeAll(async()=>{
  database=await testDatabase();await seedDraft(database.db);const q=draftInput();
  await sql`UPDATE teams SET opendota_team_id=CASE WHEN id=${q.teamAId}::bigint THEN 111 ELSE 222 END WHERE id IN (${q.teamAId}::bigint,${q.teamBId}::bigint)`.execute(database.db);
  await sql`UPDATE leagues SET opendota_league_id=1 WHERE id=1`.execute(database.db);
  const payload={match_id:matchId,start_time:Math.floor(Date.now()/1000)-600,duration:60,radiant_win:true,radiant_team_id:111,dire_team_id:222,leagueid:1,
    players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:i+123,hero_id:i+1,account_id:1000+i}))};
  const client=new OpenDotaClient({},{fetch:async url=>new Response(JSON.stringify(url.pathname==='/api/heroes'?
    Array.from({length:10},(_,i)=>({id:i+1,name:`synthetic_${i}`,localized_name:`Synthetic ${i}`})):
    url.pathname==='/api/leagues'?[{leagueid:1,name:'Synthetic event',tier:'professional'}]:payload))});
  await new IngestionService(database.db,client).ingest(matchId);
  owner=(await new AuthService(database.db).provision('synthetic-observation',randomBytes(24).toString('base64url'))).id;
},60000);

test('concurrent preparation and capture retries produce one observation and one link',async()=>{
  const scenario=await new ScenarioRepository(database.db).save(owner,input()),repo=new DraftCaptureRepository(database.db);
  const captures=await Promise.all([repo.create(owner,scenario.id,{expectedRevision:1}),repo.create(owner,scenario.id,{expectedRevision:1})]);
  expect(captures[0]).toEqual(captures[1]);
  expect((await sql`SELECT id FROM owner_draft_history_observations WHERE scenario_id=${scenario.id}::uuid`.execute(database.db)).rows).toHaveLength(1);
  expect((await sql`SELECT capture_id FROM owner_draft_history_links WHERE capture_id=${captures[0]!.id}::uuid`.execute(database.db)).rows).toHaveLength(1);
},60000);

test('failed map verification is retained; stale revision and foreign owner cannot create a capture',async()=>{
  await sql`INSERT INTO matches(id,started_at,synced_at,is_pro) VALUES(9007199254743991,'2025-01-01','2025-01-02',true)`.execute(database.db);
  const scenario=await new ScenarioRepository(database.db).save(owner,input()),repo=new DraftHistoryRepository(database.db);
  await expect(repo.prepare(randomUUID(),scenario.id,1)).rejects.toMatchObject({code:'NOT_FOUND'});
  const observation=await repo.prepare(owner,scenario.id,1);expect(observation!.evidence.outcomes).toContainEqual(expect.objectContaining({matchId:'9007199254743991',status:'unavailable'}));
  const altered=structuredClone(observation!.evidence),success=altered.outcomes.find(o=>o.status==='verified')!;
  if(success.status==='verified')success.teamAWon=!success.teamAWon;
  expect(()=>DraftHistoryEvidenceSchema.parse(altered)).toThrow('outcome_map');
  await new ScenarioRepository(database.db).save(owner,input(),{id:scenario.id,expectedRevision:1});
  await expect(new DraftCaptureRepository(database.db).create(owner,scenario.id,{expectedRevision:1})).rejects.toMatchObject({code:'CONFLICT'});
  expect((await sql`SELECT id FROM owner_draft_captures WHERE scenario_id=${scenario.id}::uuid`.execute(database.db)).rows).toHaveLength(0);
});

test('observations and links are immutable; a different scenario cannot reuse the prepared evidence',async()=>{
  const s=await new ScenarioRepository(database.db).save(owner,input()),capture=await new DraftCaptureRepository(database.db).create(owner,s.id,{expectedRevision:1});
  const observation=await new DraftHistoryRepository(database.db).get(owner,s.id,1);
  await expect(sql`UPDATE owner_draft_history_observations SET observed_at=clock_timestamp() WHERE id=${observation!.id}::uuid`.execute(database.db)).rejects.toThrow('immutable');
  await expect(sql`DELETE FROM owner_draft_history_observations WHERE id=${observation!.id}::uuid`.execute(database.db)).rejects.toThrow('immutable');
  await expect(sql`DELETE FROM owner_draft_history_links WHERE capture_id=${capture.id}::uuid`.execute(database.db)).rejects.toThrow('immutable');
  const other=await new ScenarioRepository(database.db).save(owner,input()),otherObservation=await new DraftHistoryRepository(database.db).prepare(owner,other.id,1);
  await expect(sql`INSERT INTO owner_draft_history_links(capture_id,observation_id) VALUES(${capture.id}::uuid,${otherObservation!.id}::uuid)`.execute(database.db)).rejects.toThrow('draft_history_link_invalid');
});

test('legacy captures remain readable and never receive backdated observations',async()=>{
  const seedScenario=await new ScenarioRepository(database.db).save(owner,input());
  const original=await new DraftCaptureRepository(database.db).create(owner,seedScenario.id,{expectedRevision:1});
  const legacy=await new ScenarioRepository(database.db).save(owner,input());
  await database.db.transaction().execute(async tx=>{
    const row=(await sql<{input_hash:string;input_snapshot:unknown;at:string;scenario_at:string}>`SELECT input_hash,input_snapshot,
      to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS scenario_at
      FROM scenario_input_snapshots WHERE scenario_id=${legacy.id}::uuid AND revision=1`.execute(tx)).rows[0]!;
    const snapshot={...original.snapshot,scenarioId:legacy.id,scenario:row.input_snapshot,scenarioHash:row.input_hash,scenarioRecordedAt:row.scenario_at,decisionCutoffAt:row.at};
    const text=JSON.stringify(snapshot);
    await sql`INSERT INTO owner_draft_captures(id,owner_user_id,scenario_id,revision,snapshot_text,snapshot_sha256,decision_cutoff_at)
      VALUES(${randomUUID()}::uuid,${owner}::uuid,${legacy.id}::uuid,1,${text},${registrySha(text)},${row.at}::timestamptz)`.execute(tx);
  });
  const repo=new DraftCaptureRepository(database.db),before=await repo.get(owner,legacy.id,1);
  expect(await repo.create(owner,legacy.id,{expectedRevision:1})).toEqual(before);
  expect(await new DraftHistoryRepository(database.db).get(owner,legacy.id,1)).toBeNull();
  const {readDraftHistorySummary}=await import('../src/modules/scenarios/draft-history-summary.js');
  expect(await readDraftHistorySummary(database.db,owner,legacy.id,1)).toMatchObject({status:'missing',maps:null,verifiedMaps:null,excludedMaps:null});
  expect((await sql`SELECT capture_id FROM owner_draft_history_links WHERE capture_id=${before!.id}::uuid`.execute(database.db)).rows).toHaveLength(0);
});

test('DB refuses an observation and draft linked in the same uncommitted transaction',async()=>{
  const seed=await new ScenarioRepository(database.db).save(owner,input()),repo=new DraftCaptureRepository(database.db);
  const template=await repo.create(owner,seed.id,{expectedRevision:1}),observation=(await new DraftHistoryRepository(database.db).get(owner,seed.id,1))!;
  const scenario=await new ScenarioRepository(database.db).save(owner,input());
  await expect(database.db.transaction().execute(async tx=>{
    const row=(await sql<{input_hash:string;input_snapshot:unknown;at:string;scenario_at:string}>`SELECT input_hash,input_snapshot,
      to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS scenario_at
      FROM scenario_input_snapshots WHERE scenario_id=${scenario.id}::uuid AND revision=1`.execute(tx)).rows[0]!;
    const e=structuredClone(observation.evidence);e.selection.scenarioId=scenario.id;e.selection.scenarioHash=row.input_hash;
    e.selectionSha256=registryHash(e.selection);e.readAt=row.at;e.observedAt=row.at;
    for(const o of e.outcomes)if(o.status==='verified')o.labelVerifiedAt=row.at.slice(0,23)+'Z';
    DraftHistoryEvidenceSchema.parse(e);
    const observationId=randomUUID(),captureId=randomUUID(),text=JSON.stringify(e);
    await sql`INSERT INTO owner_draft_history_observations(id,owner_user_id,scenario_id,revision,evidence_text,evidence_sha256,read_at,observed_at)
      VALUES(${observationId}::uuid,${owner}::uuid,${scenario.id}::uuid,1,${text},${registrySha(text)},${row.at}::timestamptz,${row.at}::timestamptz)`.execute(tx);
    const cutoff=(await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`.execute(tx)).rows[0]!.at;
    const s={...template.snapshot,scenarioId:scenario.id,scenarioHash:row.input_hash,scenario:row.input_snapshot,scenarioRecordedAt:row.scenario_at,decisionCutoffAt:cutoff},snapshot=JSON.stringify(s);
    await sql`INSERT INTO owner_draft_captures(id,owner_user_id,scenario_id,revision,snapshot_text,snapshot_sha256,decision_cutoff_at)
      VALUES(${captureId}::uuid,${owner}::uuid,${scenario.id}::uuid,1,${snapshot},${registrySha(snapshot)},${cutoff}::timestamptz)`.execute(tx);
    await sql`INSERT INTO owner_draft_history_links(capture_id,observation_id) VALUES(${captureId}::uuid,${observationId}::uuid)`.execute(tx);
  })).rejects.toThrow('draft_history_link_invalid');
  expect(await new DraftHistoryRepository(database.db).get(owner,scenario.id,1)).toBeNull();
});
afterAll(async()=>{await database?.close();},30000);
function input(){const q=draftInput();q.draft!.assignments=(['A','B'] as const).flatMap((teamSlot,j)=>Array.from({length:5},(_,i)=>({teamSlot,rolePos:i+1,heroId:j*5+i+1})));return q;}

test('commits compact history verification before draft cutoff and preserves retries',async()=>{
  const scenario=await new ScenarioRepository(database.db).save(owner,input()),repo=new DraftCaptureRepository(database.db);
  const capture=await repo.create(owner,scenario.id,{expectedRevision:1});
  const rows=(await sql<{evidence_text:string;evidence_sha256:string;before_cutoff:boolean}>`
    SELECT o.evidence_text,o.evidence_sha256,o.recorded_at<c.decision_cutoff_at AS before_cutoff
    FROM owner_draft_history_links l JOIN owner_draft_history_observations o ON o.id=l.observation_id
    JOIN owner_draft_captures c ON c.id=l.capture_id WHERE c.id=${capture.id}::uuid`.execute(database.db)).rows;
  expect(rows).toHaveLength(1);const row=rows[0]!;expect(row.before_cutoff).toBe(true);
  expect(registrySha(row.evidence_text)).toBe(row.evidence_sha256);
  const evidence=JSON.parse(row.evidence_text);expect(evidence.history.maps).toEqual(capture.snapshot.history.maps);
  expect(evidence.history.sourcePayloadsIncluded).toBe(false);expect(evidence.history.receipts[0]).not.toHaveProperty('source_payload');
  expect(evidence.outcomes).toContainEqual(expect.objectContaining({matchId,status:'verified',teamAWon:true}));
  expect(evidence.selection).toMatchObject({format:'owner-scenario-selection-v2',actualMatchId:null,scenarioId:scenario.id,revision:1});
  expect(evidence.primaryEligible).toBe(false);
  expect(await repo.create(owner,scenario.id,{expectedRevision:1})).toEqual(capture);
  expect((await sql`SELECT id FROM owner_draft_history_observations WHERE scenario_id=${scenario.id}::uuid`.execute(database.db)).rows).toHaveLength(1);
  expect((await sql`SELECT id FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
},60000);
