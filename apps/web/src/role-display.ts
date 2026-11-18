/** Display only: keep row references, identities and draft state; unknown/invalid roles stay last. */
export function roleSortedRows<T>(rows:readonly T[],role:(row:T)=>number|null|undefined):T[]{
 const rank=(row:T)=>{const value=role(row);return value!==null&&value!==undefined&&Number.isInteger(value)&&value>=1&&value<=5?value:6;};
 return [...rows].sort((a,b)=>rank(a)-rank(b));
}
