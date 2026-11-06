import {describe,it,expect} from 'vitest';
import {readV1FactPages} from '../src/v1-fact-pages.js';
describe('V1 fact pagination',()=>{
 it('retains all 20,001 facts including bigint IDs and page boundaries',async()=>{
  const all=Array.from({length:20001},(_,i)=>({id:String(9007199254740993n+BigInt(i)),field:'lineup'})),cursors:string[]=[];
  const result=await readV1FactPages(async(after,limit)=>{cursors.push(after);return all.filter(r=>BigInt(r.id)>BigInt(after)).slice(0,limit);});
  expect(result).toEqual(all);expect(cursors).toHaveLength(3);
 });
 it('accepts exactly the cap but rejects overflow without partial success',async()=>{
  const all=Array.from({length:7},(_,i)=>({id:String(i+1)}));
  const page=(rows:typeof all)=>async(after:string,limit:number)=>rows.filter(r=>BigInt(r.id)>BigInt(after)).slice(0,limit);
  expect(await readV1FactPages(page(all.slice(0,6)),{pageSize:2,maxRows:6})).toHaveLength(6);
  await expect(readV1FactPages(page(all),{pageSize:2,maxRows:6})).rejects.toThrow('v1_fact_inventory_limit');
 });
 it('handles empty results and rejects duplicate, unordered, invalid and oversized pages',async()=>{
  expect(await readV1FactPages(async()=>[])).toEqual([]);
  for(const rows of [[{id:'1'},{id:'1'}],[{id:'2'},{id:'1'}],[{id:'0'}],[{id:'1'},{id:'2'},{id:'3'}]])
   await expect(readV1FactPages(async()=>rows,{pageSize:1})).rejects.toThrow('v1_fact_page_invalid');
  await expect(readV1FactPages(async()=>[],{pageSize:0})).rejects.toThrow('v1_fact_page_limit');
 });
});
