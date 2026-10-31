import {sql,type Db} from '../../packages/db/src/index.js';
import {seedDraft,draftInput} from './draft.js';
import {assignSampleSeries} from './sample.js';
export function pairInput(){const q=draftInput();q.draft!.assignments=[{teamSlot:'A',rolePos:1,heroId:1},{teamSlot:'A',rolePos:2,heroId:2},{teamSlot:'B',rolePos:1,heroId:6},{teamSlot:'B',rolePos:2,heroId:7}];return q;}
/** Isolated synthetic map evidence only. */
export async function seedHeroPairs(db:Db){
  await seedDraft(db);
  await sql`UPDATE match_players SET hero_id=CASE WHEN player_slot<128 THEN player_slot+1 ELSE player_slot-122 END WHERE match_id=8001`.execute(db);
  await sql`UPDATE match_players SET hero_id=CASE WHEN player_slot<128 THEN player_slot+6 ELSE player_slot-127 END WHERE match_id=8002`.execute(db);
  for(const id of ['8001','8002'])await assignSampleSeries(db,id);
  for(let i=0;i<2;i++){
    const id=String(8031+i);
    await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id,dire_team_id)
      SELECT ${id}::bigint,${`2023-12-0${i+1}T00:00:00Z`}::timestamptz,1800,${i===0},true,radiant_team_id,dire_team_id FROM matches WHERE id=8001`.execute(db);
    await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id) SELECT ${id}::bigint,player_slot,side,hero_id FROM match_players WHERE match_id=8001`.execute(db);
    await assignSampleSeries(db,id);
  }
}
