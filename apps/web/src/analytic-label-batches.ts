export function analyticLabelBatches(patchIds:(string|null)[],heroIds:(string|null)[]){
 const batches:{kind:'patches'|'heroes';ids:string[]}[]=[];
 let omitted=0;
 for(const [kind,input] of [['patches',patchIds],['heroes',heroIds]] as const){
  const ids=[...new Set(input.filter((id):id is string=>id!==null))].sort();
  omitted+=Math.max(0,ids.length-200);
  for(let i=0;i<Math.min(ids.length,200);i+=20)batches.push({kind,ids:ids.slice(i,i+20)});
 }
 return {batches,omitted};
}
