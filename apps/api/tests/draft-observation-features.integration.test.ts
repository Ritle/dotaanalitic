import {test,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedDraft,draftInput} from '../../../tests/helpers/draft.js';
import {ScenarioRepository,sql} from '@dota/db';
import {AuthService} from '../src/modules/auth/service.js';
import {DraftCaptureRepository} from '../src/modules/scenarios/draft-capture-repository.js';
import {DraftNativeRepository} from '../src/modules/scenarios/draft-native-repository.js';
import {compileNativeExportRuntime} from '../../../tests/helpers/native-export-runtime.js';
compileNativeExportRuntime();
const {readObservationFeatures}=await import('../../../tools/audits/draft-observation-features.mjs');
const {auditObservationFeatures}=await import('../../../tools/audits/draft-observation-features-core.mjs');

test('SQL058/059/060 collector preserves committed evidence, failed attempts and pending target without writes',async()=>{
  const database=await testDatabase();
  try{
    await seedDraft(database.db);
    const owner=(await new AuthService(database.db).provision('synthetic-feature-export',randomBytes(24).toString('base64url'))).id;
    const q=draftInput();q.draft!.assignments=(['A','B'] as const).flatMap((teamSlot,j)=>Array.from({length:5},(_,i)=>({teamSlot,rolePos:i+1,heroId:j*5+i+1})));
    const scenario=await new ScenarioRepository(database.db).save(owner,q);
    const capture=await new DraftCaptureRepository(database.db).create(owner,scenario.id,{expectedRevision:1});
    await new DraftNativeRepository(database.db).create(owner,scenario.id,1,{requestId:randomUUID(),matchId:'9007199254742990'});
    const snapshot=async()=>({
      captures:(await sql`SELECT row_to_json(c) AS row FROM owner_draft_captures c ORDER BY id`.execute(database.db)).rows,
      bindings:(await sql`SELECT row_to_json(b) AS row FROM owner_draft_native_bindings b ORDER BY id`.execute(database.db)).rows,
      observations:(await sql`SELECT row_to_json(o) AS row FROM owner_draft_history_observations o ORDER BY id`.execute(database.db)).rows,
      links:(await sql`SELECT row_to_json(l) AS row FROM owner_draft_history_links l ORDER BY capture_id`.execute(database.db)).rows,
      predictions:(await sql`SELECT id FROM prediction_runs`.execute(database.db)).rows
    });
    const before=await snapshot(),source=await readObservationFeatures(database.db);
    source.native.syntheticOnly=true; // Isolated database contains synthetic fixtures only.
    const result=auditObservationFeatures(source);
    expect(result.counts).toMatchObject({captures:1,observations:1,links:1,distinctActualMaps:0,featureReadyCaptures:0,trainingExamples:0});
    expect(result.items[0].captureId).toBe(capture.id);
    expect(result.items[0].attempts[0].result.matchId).toBe('9007199254742990');
    expect(result.items[0].features.reasons).toContain('NATIVE_TARGET_UNRESOLVED');
    expect(result.items[0].features.inputs).toBeNull();
    expect(source.observations[0].recordedAt).toMatch(/\.\d{6}Z$/);
    expect(result.teamAWinProbability).toBeNull();
    expect(await snapshot()).toEqual(before);
  }finally{await database.close();}
},60000);
