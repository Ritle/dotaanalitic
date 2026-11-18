import {writeFile} from 'node:fs/promises';
import {createDatabase,V1DataRepository,sql} from '../../packages/db/dist/index.js';
import {verifiedProtocol,datasetCode,CaptureSchema,digest} from './post-draft-dataset.mjs';
const [inventory,metadata,protocolPath,output,...extra]=process.argv.slice(2);let db;
try{
 if(!output||extra.length||!process.env.DATABASE_URL)throw Error('arguments');
 const {protocol}=await verifiedProtocol(inventory,metadata,protocolPath),code=await datasetCode();
 db=createDatabase(process.env.DATABASE_URL);
 // Existing verifier uses SHARE locks: SELECT-only transaction, not PostgreSQL READ ONLY.
 const exported=await new V1DataRepository(db).export({schemaVersion:1,profile:'pre-match-player-elo-data-v1',purpose:'development_only',
  fromAt:protocol.policy.history.warmupFrom,toAt:protocol.policy.windows.at(-1).until,snapshotAt:new Date().toISOString(),maxMaps:5000},code);
 const source=exported.source,receipts=source.candidates.flatMap(m=>m.outcome.status==='verified'?[m.outcome.outcomeReceiptId]:[]);
 const heroes=await db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
  await sql`SET TRANSACTION READ ONLY`.execute(tx);
  return (await sql`SELECT m.id::text AS "matchId",m.data_revision::text AS "dataRevision",
   coalesce((SELECT jsonb_agg(jsonb_build_object('player_slot',p.player_slot,'hero_id',p.hero_id,'player_id',p.player_id::text) ORDER BY p.player_slot)
    FROM match_players p WHERE p.match_id=m.id),'[]'::jsonb) AS players,
   r.id::text AS "receiptId",r.payload_sha256 AS "sourceSha256",
   CASE WHEN r.id IS NULL THEN NULL ELSE (SELECT jsonb_agg(jsonb_build_object('player_slot',p->'player_slot','hero_id',p->'hero_id','account_id',p->'account_id'))
    FROM jsonb_array_elements(r.source_payload->'players') p) END AS "receiptPlayers"
   FROM matches m LEFT JOIN provider_ingest_receipts r ON r.canonical_match_id=m.id AND r.id=ANY(${receipts}::bigint[])
   WHERE m.is_pro IS TRUE ORDER BY m.id LIMIT 5001`.execute(tx)).rows;
 });
 const capture={format:'post-draft-capture-v1',protocolFingerprint:protocol.fingerprint,source,heroes};CaptureSchema.parse(capture);
 const bytes=JSON.stringify(capture)+'\n';if(Buffer.byteLength(bytes)>128*1024*1024)throw Error('file_limit');
 await writeFile(output,bytes,{flag:'wx'});
 console.log(JSON.stringify({status:'captured_research_only',maps:heroes.length,fingerprint:digest(capture),businessWrites:0,deployable:false}));
}catch(e){console.error(e?.code==='EEXIST'?'Файл уже существует. Укажите новое имя.':'Снимок не создан. Проверьте протокол, ревизии, лимиты и БД.');process.exitCode=1;}
finally{await db?.destroy();}
