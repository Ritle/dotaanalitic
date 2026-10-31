import {sql,MatchContextRepository,type Db} from '../../packages/db/src/index.js';
import {seedHeroPairs,pairInput} from './hero-matchups.js';
import {catalogPlayerId} from './catalog.js';
export {pairInput as reportInput};
/** Synthetic role assertions in isolated databases, never source metadata for production. */
export async function seedScenarioReports(db:Db){
  await seedHeroPairs(db);
  await sql`UPDATE matches SET source='synthetic'`.execute(db);
  for(const matchId of ['8001','8002']){
    const rows=(await sql<{player_slot:number;source_account_id:string}>`SELECT player_slot,source_account_id FROM match_players WHERE match_id=${matchId} ORDER BY player_slot`.execute(db)).rows;
    await new MatchContextRepository(db).append({matchId,fact:{field:'roles',value:rows.map(p=>({playerSlot:p.player_slot,playerId:String(BigInt(catalogPlayerId)+BigInt(p.source_account_id)-1000n),
      rolePos:(p.player_slot<128?p.player_slot:p.player_slot-128)+1,basis:'confirmed',confidence:1}))},eventAt:null,knownAt:null,fetchedAt:'2026-10-31T00:00:00.000Z',
      provider:'synthetic',providerRecordId:null,evidenceRef:'synthetic:report-roles',adapterVersion:'synthetic-v1',reviewState:'accepted',availability:'retrospective_fact',earliestStage:'post_match'});
  }
  await sql`UPDATE match_players SET kills=4,deaths=0,assists=6,gpm=400,xpm=NULL WHERE match_id=8001 AND player_slot=0`.execute(db);
}
