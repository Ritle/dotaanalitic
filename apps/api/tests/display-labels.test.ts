import {expect,test} from 'vitest';
import {DisplayLabelsQuerySchema,DisplayLabelsSchema} from '../src/modules/catalog/display-labels-contract';
test('label query preserves exact bigint strings and accepts one bounded scenario',()=>{
 const players=Array.from({length:20},(_,i)=>String(9007199254740993n+BigInt(i)));
 expect(DisplayLabelsQuerySchema.parse({teams:'1,9223372036854775807',players:players.join(',')})).toEqual({teams:['1','9223372036854775807'],players});
 expect(DisplayLabelsQuerySchema.parse({})).toEqual({teams:[],players:[]});
});
test('label query rejects unsafe IDs, extra keys and oversized inputs before SQL',()=>{
 for(const players of ['0','01','-1','1.0','1e2','9223372036854775808','1,','1 OR 1=1',Array(21).fill('1').join(',')])expect(DisplayLabelsQuerySchema.safeParse({players}).success).toBe(false);
 expect(DisplayLabelsQuerySchema.safeParse({teams:'1,2,3'}).success).toBe(false);
 expect(DisplayLabelsQuerySchema.safeParse({players:['1','2']}).success).toBe(false);
 expect(DisplayLabelsQuerySchema.safeParse({refresh:true}).success).toBe(false);
});
test('display response permits blank names but never claims historical identity evidence',()=>{
 const response={source:'local_catalogue',readAt:'2026-11-11T00:00:00.000Z',teams:[],players:[{id:'9007199254740993',name:''}]};
 expect(DisplayLabelsSchema.parse(response)).toEqual(response);
 expect(DisplayLabelsSchema.safeParse({...response,knownAt:response.readAt}).success).toBe(false);
});
