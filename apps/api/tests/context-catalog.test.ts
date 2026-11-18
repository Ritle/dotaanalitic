import {expect,test} from 'vitest';
import {ContextCatalogQuerySchema,ContextCatalogSchema} from '../src/modules/catalog/context-catalog-contract';
test('context lookup retains bigint keys, literal search and bounded pages',()=>{
 expect(ContextCatalogQuerySchema.parse({kind:'leagues',id:'9007199254741999'})).toEqual({kind:'leagues',id:'9007199254741999',query:'',offset:0});
 expect(ContextCatalogQuerySchema.parse({kind:'patches',query:' %_ ',offset:'20'})).toEqual({kind:'patches',query:'%_',offset:20});
});
test('context lookup rejects ambiguous modes, unsafe IDs and unbounded input',()=>{
 for(const q of [{kind:'matches'},{kind:'leagues',id:'0'},{kind:'leagues',id:'9223372036854775808'},
  {kind:'patches',query:'a'.repeat(81)},{kind:'patches',offset:10001},{kind:'patches',offset:-1},
  {kind:'patches',id:'1',query:'name'},{kind:'patches',id:'1',offset:20},{kind:'patches',refresh:true}])expect(ContextCatalogQuerySchema.safeParse(q).success).toBe(false);
});

test('reference filters accept local hero, opponent organization and canonical player IDs without coercion',()=>{
 for(const kind of ['heroes','teams','players']){
  expect(ContextCatalogQuerySchema.parse({kind,id:'9007199254741999'})).toMatchObject({kind,id:'9007199254741999'});
  expect(ContextCatalogSchema.parse({kind,source:'local_catalogue',readAt:'2026-11-11T00:00:00.000Z',items:[],hasMore:false}).kind).toBe(kind);
 }
});
test('context names are metadata only, with explicit missing and empty-name results',()=>{
 const response={kind:'leagues',source:'local_catalogue',readAt:'2026-11-11T00:00:00.000Z',items:[{id:'1',name:''}],hasMore:false};
 expect(ContextCatalogSchema.parse(response)).toEqual(response);
 expect(ContextCatalogSchema.safeParse({...response,knownAt:response.readAt}).success).toBe(false);
 expect(ContextCatalogSchema.safeParse({...response,items:Array(21).fill({id:'1',name:'x'})}).success).toBe(false);
});


test('exact team batches accept20 bigint keys without changing legacy query shapes',()=>{
 const ids=Array.from({length:20},(_,i)=>String(9007199254740993n+BigInt(i)));
 expect(ContextCatalogQuerySchema.parse({kind:'teams',ids:ids.join(',')})).toEqual({kind:'teams',ids,query:'',offset:0});
 expect(ContextCatalogQuerySchema.parse({kind:'teams',id:ids[0]})).toEqual({kind:'teams',id:ids[0],query:'',offset:0});
});
test('team batches reject empty, oversized, unsafe and mixed lookup modes',()=>{
 for(const q of [{kind:'teams',ids:''},{kind:'teams',ids:Array(21).fill('1').join(',')},{kind:'teams',ids:'0'},
  {kind:'teams',ids:'9223372036854775808'},{kind:'teams',ids:'1,2',id:'1'},{kind:'teams',ids:'1,2',query:'x'},
  {kind:'teams',ids:'1,2',offset:1},{kind:'players',ids:'1,2'},{kind:'teams',ids:'1);DROP TABLE teams'}])expect(ContextCatalogQuerySchema.safeParse(q).success).toBe(false);
});

test('analytic patch and hero batches retain exact local keys and old response shape',()=>{
 for(const kind of ['patches','heroes']){
  const ids=Array.from({length:20},(_,i)=>String(9007199254740993n+BigInt(i)));
  expect(ContextCatalogQuerySchema.parse({kind,ids:ids.join(',')})).toEqual({kind,ids,query:'',offset:0});
  for(const q of [{kind,ids:''},{kind,ids:[...ids,'1'].join(',')},{kind,ids:'0'},
   {kind,ids:'1',id:'1'},{kind,ids:'1',query:'x'},{kind,ids:'1',offset:1},
   {kind,ids:'9223372036854775808'},{kind,ids:'1);DROP TABLE patches'}])expect(ContextCatalogQuerySchema.safeParse(q).success).toBe(false);
 }
 expect(ContextCatalogQuerySchema.safeParse({kind:'leagues',ids:'1'}).success).toBe(false);
});
