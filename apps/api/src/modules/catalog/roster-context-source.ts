import {createHash} from 'node:crypto';
import {CatalogueObservationSchema,ProPlayersSchema} from '@dota/ingestion';

/** A registry membership is a current suggestion, never pre-map attendance evidence. */
export function readRosterRegistry(input:unknown,now:string){
 const observation=CatalogueObservationSchema.parse(input);
 if(observation.source.endpoint!=='/proPlayers'||observation.source.fetchedAt>now||
  createHash('sha256').update(observation.rawBody).digest('hex')!==observation.source.payloadSha256)throw Error('registry_source_invalid');
 const players=ProPlayersSchema.parse(JSON.parse(observation.rawBody));
 if(players.some(p=>p.steamid&&BigInt(p.steamid)!==76561197960265728n+BigInt(p.account_id)))throw Error('registry_account_invalid');
 return {source:observation.source,players};
}
