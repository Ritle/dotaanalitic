import {rosterOverlap} from './roster.js';
/** Descriptive, unweighted observations. Callers establish pro/completion and identity evidence. */
export type RosterMember = {playerId:string|null;rolePos:number;isStandin:boolean};
export type RosterSide = {matchId:string;startedAt:string;side:'radiant'|'dire';organizationId:string|null;
  won:boolean;patchId:string|null;syncedAt:string;players:{playerId:string|null;rolePos:number|null}[]};
const key=(ids:readonly string[])=>[...ids].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0).join(':');
const complete=(s:RosterSide)=>s.players.length===5&&s.players.every(p=>p.playerId!==null)&&new Set(s.players.map(p=>p.playerId)).size===5;
function sample(sides:readonly RosterSide[],known:boolean,recentFrom:string){
  if(!known)return {nRaw:null,wins:null,winRate:null,recentMaps:null,firstAt:null,lastAt:null,dataUpdatedAt:null,patchDistribution:[]};
  const unique=[...new Map(sides.map(s=>[s.matchId,s])).values()];
  const wins=unique.filter(s=>s.won).length,dates=unique.map(s=>s.startedAt).sort();
  const patches=new Map<string|null,number>();for(const s of unique)patches.set(s.patchId,(patches.get(s.patchId)??0)+1);
  return {nRaw:unique.length,wins,winRate:unique.length?wins/unique.length:null,recentMaps:unique.filter(s=>s.startedAt>=recentFrom).length,
    firstAt:dates[0]??null,lastAt:dates.at(-1)??null,dataUpdatedAt:unique.map(s=>s.syncedAt).sort().at(-1)??null,
    patchDistribution:[...patches].sort(([a],[b])=>(a??'').localeCompare(b??'')).map(([patchId,maps])=>({patchId,maps}))};
}
export function describeRoster(lineup:readonly RosterMember[],history:readonly RosterSide[],verifiedIds:ReadonlySet<string>,recentFrom:string,organizationId:string){
  const known=(id:string|null):id is string=>id!==null&&verifiedIds.has(id);
  const ids=lineup.map(p=>p.playerId),allKnown=ids.every(known);
  const exact=allKnown?history.filter(s=>complete(s)&&key(s.players.map(p=>p.playerId!))===key(ids)):[];
  const pairs=[];
  for(let a=0;a<lineup.length;a++)for(let b=a+1;b<lineup.length;b++){
    const left=ids[a]!,right=ids[b]!,available=known(left)&&known(right);
    const sides=available?history.filter(s=>complete(s)&&[left,right].every(id=>s.players.some(p=>p.playerId===id))):[];
    pairs.push({playerIds:[left,right],...sample(sides,available,recentFrom),organizationMaps:available?sides.filter(s=>s.organizationId===organizationId).length:null});
  }
  return {lineup:[...lineup],fingerprint:allKnown?key(ids):null,exactFive:sample(exact,allKnown,recentFrom),
    exactFiveOrganizationMaps:allKnown?exact.filter(s=>s.organizationId===organizationId).length:null,pairs,
    players:lineup.map(member=>{
      const available=known(member.playerId),sides=available?history.filter(s=>s.players.some(p=>p.playerId===member.playerId)):[];
      const confirmed=sides.filter(s=>s.players.find(p=>p.playerId===member.playerId)?.rolePos!==null);
      const organizations=new Map<string|null,RosterSide[]>();for(const side of sides){const group=organizations.get(side.organizationId)??[];group.push(side);organizations.set(side.organizationId,group);}
      return {...member,identityStatus:available?'verified' as const:'unknown' as const,...sample(sides,available,recentFrom),
        confirmedRoleMaps:available?confirmed.length:null,selectedRoleMaps:available?confirmed.filter(s=>s.players.find(p=>p.playerId===member.playerId)?.rolePos===member.rolePos).length:null,
        organizations:[...organizations].map(([organizationId,rows])=>({organizationId,...sample(rows,true,recentFrom)}))};
    })};
}
export function compareRosters(expected:readonly RosterMember[]|null,actual:readonly RosterMember[]){
  if(!expected||[...expected,...actual].some(p=>p.playerId===null))return null;
  const retained=actual.filter(p=>expected.some(e=>e.playerId===p.playerId));
  const overlap=rosterOverlap(expected.map(p=>p.playerId!),actual.map(p=>p.playerId!));
  return {...overlap,addedPairLinks:overlap.lostPairLinks,
    roleChanges:retained.filter(p=>expected.find(e=>e.playerId===p.playerId)!.rolePos!==p.rolePos).length};
}
/** Adjacent organization maps; an incomplete middle map is NOT skipped to manufacture continuity. */
export function describeChurn(history:readonly RosterSide[],organizationId:string,limit:number){
  const sides=history.filter(s=>s.organizationId===organizationId).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||(BigInt(a.matchId)>BigInt(b.matchId)?-1:1)).slice(0,limit);
  const transitions=sides.slice(1).map((older,i)=>{
    const newer=sides[i]!,retainedPlayers=complete(older)&&complete(newer)?newer.players.filter(p=>older.players.some(o=>o.playerId===p.playerId)).length:null;
    return {fromMatchId:older.matchId,toMatchId:newer.matchId,retainedPlayers,changedPlayers:retainedPlayers===null?null:5-retainedPlayers};
  });
  const allComplete=sides.every(complete),known=transitions.filter(t=>t.retainedPlayers!==null);
  return {limit,maps:sides.length,completeMaps:sides.filter(complete).length,
    uniqueFives:allComplete&&sides.length?new Set(sides.map(s=>key(s.players.map(p=>p.playerId!)))).size:null,
    changedTransitions:transitions.length&&known.length===transitions.length?known.filter(t=>t.changedPlayers!>0).length:null,
    meanRetainedPlayers:known.length?known.reduce((n,t)=>n+t.retainedPlayers!,0)/known.length:null,knownTransitions:known.length,transitions};
}
