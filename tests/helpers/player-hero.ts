import {sql,type Db} from '../../packages/db/src/index.js';
import {seedProMaps} from './pro-maps.js';
/** Synthetic individual metrics. Never seed production training or the working DB. */
export async function seedPlayerHeroes(db:Db){
  await seedProMaps(db,{swapSecondRoles:true});
  for(let i=2;i<=10;i++)await sql`INSERT INTO heroes(id,internal_name,localized_name) VALUES(${i},${'synthetic_hero_'+i},${'Synthetic Hero '+i})`.execute(db);
  await sql`UPDATE match_players SET hero_id=CASE WHEN player_slot<128 THEN player_slot+1 ELSE player_slot-122 END`.execute(db);
  // Same canonical player and hero, opposite native side and a different confirmed role on map two.
  await sql`UPDATE match_players SET hero_id=CASE WHEN player_slot=128 THEN 1 WHEN player_slot=0 THEN 6 ELSE hero_id END WHERE match_id=8002`.execute(db);
  await sql`UPDATE match_players SET kills=4,deaths=0,assists=6,gpm=400,xpm=NULL WHERE match_id=8001 AND player_slot=0`.execute(db);
  await sql`UPDATE match_players SET kills=10,deaths=2,assists=NULL,gpm=NULL,xpm=600 WHERE match_id=8002 AND player_slot=128`.execute(db);
}
