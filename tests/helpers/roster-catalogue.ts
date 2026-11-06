import {createHash} from 'node:crypto';
export function syntheticCatalogue(options:{withoutMembership?:boolean}={}){
 const at=new Date().toISOString(),calls:string[]=[];
 const players=Array.from({length:12},(_,i)=>({account_id:1001+i,steamid:String(76561197960265728n+BigInt(1001+i)),
  name:i===0||i===6?'Synthetic Twin':`Synthetic Player ${i+1}`,team_id:options.withoutMembership?0:i<6?71:72,team_name:options.withoutMembership?'Old organization':i<6?'Synthetic Alpha':'Synthetic Beta'}));
 const observe=(endpoint:string,data:unknown)=>{const rawBody=JSON.stringify(data);return {rawBody,source:{endpoint,fetchedAt:at,payloadSha256:createHash('sha256').update(rawBody).digest('hex')}};};
 const registry=observe('/proPlayers',players);
 const teams=[{team_id:71,name:'Synthetic Alpha',tag:'SYN'},{team_id:72,name:'Synthetic Beta',tag:'SYN'},{team_id:703,name:'New team without registered members',tag:'NEW'},{team_id:704,name:'Profile-only organization',tag:'PROFILE'}];
 return {calls,players,registry,provider:async(key:string,query?:string)=>{calls.push(key);
  if(key.startsWith('search:'))return observe('/search?q='+encodeURIComponent(query??''),query==='synthetic undiscovered'?[{account_id:199,personaname:'Synthetic undiscovered'}]:[]);
  if(key.startsWith('player:')){const id=Number(key.slice(7));return observe('/players/'+id,{profile:{account_id:id===198?999:id,steamid:String(76561197960265728n+BigInt(id)),name:null,personaname:'Synthetic new nickname '+id}});}
  return key==='registry'?registry:key==='directory'?observe('/teams',teams):observe('/teams/'+key.slice(5),teams.find(t=>String(t.team_id)===key.slice(5))??{});}};
}
