import { sql, type Db } from '../../packages/db/src/index.js';

/** Synthetic catalogue and map rows; never seed the working database. */
export const catalogTeamId='9007199254740993';
export const catalogPlayerId='9007199254741010';
export async function seedCatalog(db:Db) {
  await sql`INSERT INTO teams(id,name,tag,synced_at) VALUES (${catalogTeamId},'Synthetic Aurora','SYN','2024-01-02T00:00:00Z'),
    (9007199254740994,'Synthetic Aurora','OTHER',NULL),(9007199254740995,'Literal %_','PCT',NULL)`.execute(db);
  for(let i=0;i<6;i++) await sql`INSERT INTO players(id,nickname,opendota_account_id) VALUES (${String(BigInt(catalogPlayerId)+BigInt(i))},
    ${i<2?'Synthetic Twin':'Synthetic Player '+i},${1000+i})`.execute(db);
  await sql`INSERT INTO heroes(id,internal_name,localized_name) VALUES(1,'synthetic_hero','Synthetic Hero')`.execute(db);
  // Most recent accepted pro map puts our organization on Dire. Public and unknown maps must not replace it.
  for(const [id,date,pro] of [['8001','2024-01-01',true],['8002','2024-01-02',true],['8003','2024-01-03',false],['8004','2024-01-04',null]] as const) {
    await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id,dire_team_id)
      VALUES(${id},${date+'T12:00:00Z'},1800,true,${pro},${id==='8001'?catalogTeamId:'9007199254740994'},${id==='8001'?'9007199254740994':catalogTeamId})`.execute(db);
    for(let i=0;i<5;i++)await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id,player_id)
      VALUES(${id},${id==='8001'?i:128+i},${id==='8001'?'radiant':'dire'},1,${String(BigInt(catalogPlayerId)+BigInt(i))})`.execute(db);
  }
  // A misleading current-members observation is irrelevant to the map-side lineup.
  await sql`INSERT INTO team_roster_periods(team_id,player_id,source,verified) VALUES(${catalogTeamId},${String(BigInt(catalogPlayerId)+5n)},'manual',true)`.execute(db);
}
