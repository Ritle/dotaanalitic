/** Bounded keyset read inside the caller's repeatable-read snapshot. Never truncate provenance. */
export async function readV1FactPages<T extends {id:string}>(
  page:(afterId:string,limit:number)=>Promise<T[]>,
  {pageSize=10000,maxRows=250000}:{pageSize?:number;maxRows?:number}={}
):Promise<T[]> {
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>10000||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>250000)
    throw Error('v1_fact_page_limit');
  const result:T[]=[];let after='0';
  for(;;){
    const limit=Math.min(pageSize,maxRows-result.length)+1,rows=await page(after,limit);
    if(rows.length>limit)throw Error('v1_fact_page_invalid');
    let previous=BigInt(after);
    for(const row of rows){
      if(!/^[1-9]\d{0,18}$/.test(row.id)||BigInt(row.id)<=previous)throw Error('v1_fact_page_invalid');
      previous=BigInt(row.id);
    }
    if(result.length+rows.length>maxRows)throw Error('v1_fact_inventory_limit');
    const more=rows.length===limit,selected=more?rows.slice(0,-1):rows;
    result.push(...selected);
    if(!more)return result;
    after=selected.at(-1)!.id;
  }
}
