import {expect,test} from 'vitest';
import {ContextCatalogQuerySchema,ContextCatalogSchema} from '../src/modules/catalog/context-catalog-contract';
test('context lookup retains bigint keys, literal search and bounded pages',()=>{
 expect(ContextCatalogQuerySchema.parse({kind:'leagues',id:'9007199254741999'})).toEqual({kind:'leagues',id:'9007199254741999',query:'',offset:0});
 expect(ContextCatalogQuerySchema.parse({kind:'patches',query:' %_ ',offset:'20'})).toEqual({kind:'patches',query:'%_',offset:20});
});
test('context lookup rejects ambiguous modes, unsafe IDs and unbounded input',()=>{
 for(const q of [{kind:'heroes'},{kind:'leagues',id:'0'},{kind:'leagues',id:'9223372036854775808'},
  {kind:'patches',query:'a'.repeat(81)},{kind:'patches',offset:10001},{kind:'patches',offset:-1},
  {kind:'patches',id:'1',query:'name'},{kind:'patches',id:'1',offset:20},{kind:'patches',refresh:true}])expect(ContextCatalogQuerySchema.safeParse(q).success).toBe(false);
});
test('context names are metadata only, with explicit missing and empty-name results',()=>{
 const response={kind:'leagues',source:'local_catalogue',readAt:'2026-11-11T00:00:00.000Z',items:[{id:'1',name:''}],hasMore:false};
 expect(ContextCatalogSchema.parse(response)).toEqual(response);
 expect(ContextCatalogSchema.safeParse({...response,knownAt:response.readAt}).success).toBe(false);
 expect(ContextCatalogSchema.safeParse({...response,items:Array(21).fill({id:'1',name:'x'})}).success).toBe(false);
});
