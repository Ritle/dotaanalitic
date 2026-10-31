import {sql,GameRegistryRepository,type Db} from '../../packages/db/src/index.js';
import {seedStrength} from './strength.js';
import {catalogTeamId,catalogPlayerId} from './catalog.js';
export const compareInput=()=>({teamAId:catalogTeamId,teamBId:'9007199254740994',fromAt:'2024-01-01T00:00:00.000Z',cutoffAt:'2024-01-03T00:00:00.000Z',
  lineupA:Array.from({length:5},(_,i)=>({playerId:String(BigInt(catalogPlayerId)+BigInt(i)),rolePos:i+1,isStandin:false})),
  lineupB:Array.from({length:5},(_,i)=>({playerId:String(BigInt(catalogPlayerId)+5n+BigInt(i)),rolePos:i+1,isStandin:false}))});
/** Synthetic only, isolated disposable databases; no model quality claim. */
export async function seedCompare(db:Db){
  await seedStrength(db);
  await sql`INSERT INTO patches(id,label,released_at) VALUES (1,'synthetic comparison patch','2023-01-01')`.execute(db);
  await new GameRegistryRepository(db).appendPatch({patchId:'1',releasedAt:'2023-01-01T00:00:00.000Z',coverageUntil:'2025-01-01T00:00:00.000Z',
    eventAt:null,knownAt:'2023-01-01T00:00:00.000Z',fetchedAt:'2026-10-31T00:00:00.000Z',source:'synthetic',evidenceRef:'synthetic:comparison-release',reviewState:'accepted'});
}
