#!/usr/bin/env node
/** Processes only the player-history queue; never consumes organization/map jobs. */
import {createDatabase} from '../packages/db/dist/index.js';
import {createPlayerHistoryQueue,registerPlayerHistoryWorker,livePlayerHistoryProvider} from '../packages/ingestion/dist/index.js';
let db,boss;
try{
 db=createDatabase(process.env.DATABASE_URL);boss=await createPlayerHistoryQueue(process.env.DATABASE_URL);
 await registerPlayerHistoryWorker(boss,db,signal=>livePlayerHistoryProvider(db,process.env,signal));
 console.log(JSON.stringify({status:'ready',queue:'opendota-player-history'}));
 await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
}catch{console.error(JSON.stringify({code:'player_history_worker_unavailable'}));process.exitCode=1;}
finally{await boss?.stop({graceful:true,timeout:10000});await db?.destroy();}
