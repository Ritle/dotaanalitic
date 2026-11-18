import {LineupTemplateReportSchema} from '../../api/src/modules/catalog/lineup-templates-contract';

/** Copy owner-confirmed identities, never provider guesses or names, into a new map. */
export function confirmedMapLineups(teamAId:string,teamBId:string,cutoffAt:string,a:unknown,b:unknown){
 const reports=[a,b].map(value=>LineupTemplateReportSchema.safeParse(value));
 const cutoff=Date.parse(cutoffAt);
 if(!Number.isFinite(cutoff)||!teamAId||teamAId===teamBId)return null;
 const [left,right]=reports;
 if(!left?.success||!right?.success)return null;
 const ta=left.data.current,tb=right.data.current;
 if(!ta||!tb||left.data.teamId!==teamAId||right.data.teamId!==teamBId||ta.teamId!==teamAId||tb.teamId!==teamBId)return null;
 if(Date.parse(ta.confirmedAt)>cutoff||Date.parse(tb.confirmedAt)>cutoff)return null;
 if(new Set([...ta.lineup,...tb.lineup].map(p=>p.playerId)).size!==10)return null;
 const copy=(rows:typeof ta.lineup)=>rows.map(p=>({...p,isStandin:false})).sort((x,y)=>x.rolePos-y.rolePos);
 return {lineupA:copy(ta.lineup),lineupB:copy(tb.lineup)};
}
