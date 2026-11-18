/** Read-only, label-free metadata for protocol planning; not a dataset exporter. */
import {writeFile} from 'node:fs/promises';
import {createDatabase,sql} from '../../packages/db/dist/index.js';
const [output,...extra]=process.argv.slice(2);let db;
try{
 if(!output||extra.length||!process.env.DATABASE_URL)throw Error('arguments');db=createDatabase(process.env.DATABASE_URL);
 const rows=await db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
  await sql`SET TRANSACTION READ ONLY`.execute(tx);
  return (await sql`SELECT m.id::text AS "matchId",m.series_id::text AS "seriesId",m.started_at AS "startedAt",
   m.started_at+make_interval(secs=>m.duration_seconds) AS "completedAt",m.map_number AS "mapNumber",m.league_id::text AS "leagueId",
   m.data_revision::text AS "dataRevision",s.provider_series_id::text AS "sourceSeriesId",s.provider AS "seriesProvider",
   r.source_payload->>'game_mode' AS "gameMode",r.source_payload->>'lobby_type' AS "lobbyType"
   FROM matches m LEFT JOIN series s ON s.id=m.series_id
   LEFT JOIN LATERAL (SELECT * FROM match_quality_assessments WHERE match_id=m.id ORDER BY assessed_at DESC,id DESC LIMIT 1) q ON true
   LEFT JOIN match_source_snapshots source ON source.id=q.source_snapshot_id AND source.match_id=m.id
   LEFT JOIN provider_ingest_receipts r ON r.id::text=q.metrics->>'receipt_id' AND r.canonical_match_id=m.id
    AND r.provider_match_id=m.id::text AND r.provider=source.provider AND r.payload_sha256=source.payload_sha256
    AND source.provider_match_id=r.provider_match_id
   WHERE m.is_pro IS TRUE ORDER BY m.started_at,m.id LIMIT 5001`.execute(tx)).rows;
 });
 if(rows.length>5000)throw Error('limit');await writeFile(output,JSON.stringify(rows,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:'complete',maps:rows.length,labelsRead:false,businessWrites:0}));
}catch(e){console.error(e?.code==='EEXIST'?'Файл метаданных уже существует. Укажите новое имя.':'Не удалось прочитать метаданные. Проверьте аргументы, БД и миграции.');process.exitCode=1;}
finally{await db?.destroy();}
