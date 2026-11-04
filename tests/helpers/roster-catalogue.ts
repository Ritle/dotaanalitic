import {createHash} from 'node:crypto';
export function syntheticCatalogue(){
 const at=new Date().toISOString(),calls:string[]=[];
 const players=Array.from({length:12},(_,i)=>({account_id:1001+i,steamid:String(76561197960265728n+BigInt(1001+i)),
  name:i===0||i===6?'Synthetic Twin':`Synthetic Player ${i+1}`,team_id:i<6?71:72,team_name:i<6?'Synthetic Alpha':'Synthetic Beta'}));
 const observe=(endpoint:string,data:unknown)=>{const rawBody=JSON.stringify(data);return {rawBody,source:{endpoint,fetchedAt:at,payloadSha256:createHash('sha256').update(rawBody).digest('hex')}};};
 const registry=observe('/proPlayers',players);
 return {calls,players,registry,provider:async(key:string)=>{calls.push(key);return key==='registry'?registry:observe('/teams/'+key.slice(5),{team_id:Number(key.slice(5)),name:key==='team:71'?'Synthetic Alpha':'Synthetic Beta',tag:'SYN'});}};
}
