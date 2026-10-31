import {IdentityRepository,MatchContextRepository,GameRegistryRepository,sql,type Db} from '../../packages/db/src/index.js';
import {seedCatalog,catalogPlayerId} from './catalog.js';
/** Synthetic current descriptive identity/role/release proofs, never real source evidence. */
export async function seedProMaps(db:Db){
  await seedCatalog(db);
  const identity=new IdentityRepository(db),context=new MatchContextRepository(db);
  const fetchedAt='2026-10-31T00:00:00.000Z';
  for(let i=0;i<10;i++){
    const playerId=String(BigInt(catalogPlayerId)+BigInt(i));
    if(i>=6)await sql`INSERT INTO players(id,nickname) VALUES(${playerId},'Synthetic pro-map player')`.execute(db);
    await identity.appendAccountEvidence({playerId,externalAccountId:String(1000+i),provider:'opendota',status:'verified',
      eventAt:null,knownAt:null,fetchedAt,evidenceRef:'synthetic:current-identity-'+i,source:'synthetic'});
  }
  await sql`UPDATE match_players SET source_account_id=player_id-${catalogPlayerId}::bigint+1000`.execute(db);
  for(const matchId of ['8001','8002']){
    for(let i=0;i<5;i++)await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id,source_account_id)
      VALUES(${matchId},${matchId==='8001'?128+i:i},${matchId==='8001'?'dire':'radiant'},1,${1005+i})`.execute(db);
    await context.append({matchId,fact:{field:'roles',value:Array.from({length:5},(_,i)=>({playerSlot:matchId==='8001'?i:128+i,
      playerId:String(BigInt(catalogPlayerId)+BigInt(i)),rolePos:i+1,basis:'confirmed',confidence:1}))},
      eventAt:null,knownAt:null,fetchedAt,availability:'retrospective_fact',earliestStage:'post_match',provider:'synthetic',
      providerRecordId:null,evidenceRef:'synthetic:observed-roles',adapterVersion:'synthetic-v1',reviewState:'accepted'});
  }
  await sql`INSERT INTO patches(id,label,released_at) VALUES(1,'synthetic reviewed','2023-01-01'),(2,'synthetic unreviewed','2023-12-31')`.execute(db);
  await sql`UPDATE matches SET patch_id=2`.execute(db);
  await new GameRegistryRepository(db).appendPatch({patchId:'1',releasedAt:'2023-01-01T00:00:00.000Z',coverageUntil:'2025-01-01T00:00:00.000Z',
    eventAt:null,knownAt:fetchedAt,fetchedAt,source:'synthetic',evidenceRef:'synthetic:reviewed-release',reviewState:'accepted'});
}
