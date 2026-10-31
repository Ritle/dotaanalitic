import {createHash} from 'node:crypto';
import {IdentityRepository,MatchContextRepository,sql,type Db} from '../../packages/db/src/index.js';
import {seedCatalog,catalogPlayerId} from './catalog.js';
export async function seedStrength(db:Db){
  await seedCatalog(db);
  for(let i=0;i<15;i++){
    const playerId=String(BigInt(catalogPlayerId)+BigInt(i));
    if(i>=6)await sql`INSERT INTO players(id,nickname) VALUES(${playerId},'Synthetic strength player')`.execute(db);
    await new IdentityRepository(db).appendAccountEvidence({playerId,externalAccountId:String(1000+i),provider:'opendota',status:'verified',eventAt:null,
      knownAt:'2023-01-01T00:00:00.000Z',fetchedAt:'2026-10-31T00:00:00.000Z',evidenceRef:'synthetic:dated-account-'+i,source:'synthetic'});
  }
  await sql`UPDATE match_players SET source_account_id=player_id-${catalogPlayerId}::bigint+1000`.execute(db);
  for(const id of ['8001','8002']){
    for(let i=0;i<5;i++)await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id,source_account_id)
      VALUES(${id},${id==='8001'?128+i:i},${id==='8001'?'dire':'radiant'},1,${1005+i})`.execute(db);
    await addStrengthEvidence(db,id);
  }
}
/** Explicit synthetic known-at proofs, never seed working DB or assert live source coverage. */
export async function addStrengthEvidence(db:Db,matchId:string,outcomeKnownAt?:string){
  const m=(await sql<{ended_at:Date;radiant_win:boolean}>`SELECT started_at+make_interval(secs=>duration_seconds) AS ended_at,radiant_win FROM matches WHERE id=${matchId}`.execute(db)).rows[0]!;
  const end=m.ended_at.toISOString(),fetchedAt='2026-10-31T00:00:00.000Z';
  const players=(await sql<{player_slot:number;source_account_id:string}>`SELECT player_slot,source_account_id FROM match_players WHERE match_id=${matchId} ORDER BY player_slot`.execute(db)).rows;
  await new MatchContextRepository(db).append({matchId,fact:{field:'lineup',value:players.map(p=>({playerSlot:p.player_slot,playerId:String(BigInt(catalogPlayerId)+BigInt(p.source_account_id)-1000n)}))},
    eventAt:end,knownAt:end,fetchedAt,provider:'synthetic',providerRecordId:null,evidenceRef:'synthetic:dated-participation',adapterVersion:'synthetic-v1',
    availability:'verified_asof',earliestStage:'post_match',reviewState:'accepted'});
  for(const [field,value] of [['pro_classification',{value:true}],['radiant_win',m.radiant_win]] as const){
    const json=JSON.stringify(value),digest=createHash('sha256').update(json).digest('hex'),known=field==='radiant_win'?outcomeKnownAt??end:end;
    await sql`INSERT INTO match_field_observations(match_id,field_name,provider,value,event_at,known_at,fetched_at,evidence_ref,adapter_version,value_sha256,
      review_state,availability_class,earliest_stage) VALUES(${matchId},${field},'synthetic',${json}::jsonb,${end},${known},${fetchedAt},
      'synthetic:dated-fact','synthetic-v1',${digest},'accepted','verified_asof','post_match')`.execute(db);
  }
}
