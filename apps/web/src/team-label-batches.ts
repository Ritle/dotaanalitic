/** Local organization keys only; never coerce bigint IDs or infer player identities. */
export function teamLabelBatches(ids:readonly(string|null)[]):string[][]{
 const unique=[...new Set(ids.filter((id):id is string=>id!==null))].sort().slice(0,100);
 return Array.from({length:Math.ceil(unique.length/20)},(_,i)=>unique.slice(i*20,i*20+20));
}
