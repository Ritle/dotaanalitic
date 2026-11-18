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
// SQL061 stores the executing implementation digest: use the same built runtime as the offline exporter.
const {DraftShadowRepository}=await import('../dist/modules/scenarios/draft-shadow-repository.js');
const {shadowImplementationSha}=await import('../dist/modules/scenarios/draft-shadow-runtime.js');
const {readCommittedShadow}=await import('../../../tools/audits/draft-committed-shadow.mjs');
const {auditCommittedShadow}=await import('../../../tools/audits/draft-committed-shadow-core.mjs');

test('read-only SQL058-061 export preserves missing/awaiting/committed states and all source bytes',async()=>{
 const database=await testDatabase();
 try{
   await seedDraft(database.db);
   const owner=(await new AuthService(database.db).provision('synthetic-committed-export',randomBytes(24).toString('base64url'))).id;
   const shadow=new DraftShadowRepository(database.db,async()=>null),captures=[];
   for(let i=0;i<3;i++){
     const q=draftInput();q.draft!.assignments=(['A','B'] as const).flatMap((teamSlot,j)=>Array.from({length:5},(_,k)=>({teamSlot,rolePos:k+1,heroId:j*5+k+1})));
     const s=await new ScenarioRepository(database.db).save(owner,q);
     captures.push(await new DraftCaptureRepository(database.db).create(owner,s.id,{expectedRevision:1}));
     if(i===0)await shadow.ensure(owner,s.id,1);if(i===1)await shadow.persistResult(owner,s.id,1);
     if(i===2)await new DraftNativeRepository(database.db).create(owner,s.id,1,{requestId:randomUUID(),matchId:'9007199254742990'});
   }
   const snapshot=async()=>{
     const result:Record<string,unknown>={};
     for(const table of ['owner_draft_captures','owner_draft_history_observations','owner_draft_history_links','owner_draft_native_bindings',
       'owner_draft_shadow_runs','owner_draft_shadow_receipts','prediction_runs'])
       result[table]=(await sql`SELECT to_jsonb(t) AS row FROM ${sql.table(table)} AS t ORDER BY to_jsonb(t)::text`.execute(database.db)).rows;
     return result;
   };
   const before=await snapshot(),source=await readCommittedShadow(database.db);
   source.history.native.syntheticOnly=true; // Isolated test database, never production evidence.
   const r=auditCommittedShadow(source,await shadowImplementationSha());
   expect(r.counts).toMatchObject({captures:3,runs:2,receipts:1,observations:3,links:3,bindingAttempts:1,
     missingResults:1,awaitingReceipts:1,committedUnavailable:1,committedComputed:0,primaryExamples:0,trainingExamples:0});
   expect(source.runs.every((v:{recordedAt:string})=>/\.\d{6}Z$/.test(v.recordedAt))).toBe(true);
   expect(r.items.find((v:{captureId:string})=>v.captureId===captures[2]!.id).bindingAttempts[0].result.matchId).toBe('9007199254742990');
   expect(await snapshot()).toEqual(before);expect(r.teamAWinProbability).toBeNull();
 }finally{await database.close();}
},60000);
