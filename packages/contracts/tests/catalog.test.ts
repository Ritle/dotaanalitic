import {expect,test} from 'vitest';
import {CatalogIdSchema,CatalogQuerySchema} from '../src/catalog.js';
test('external IDs reject nondecimal and overflow values without throwing inside safeParse',()=>{
  for(const id of ['1e3','0x10','0','-1','01','NaN','9223372036854775808','9'.repeat(100),'1; DROP TABLE teams'])
    expect(CatalogIdSchema.safeParse(id).success,id).toBe(false);
  expect(CatalogIdSchema.parse('9007199254740993')).toBe('9007199254740993');
  expect(CatalogIdSchema.parse('9223372036854775807')).toBe('9223372036854775807');
});
test('catalogue search bounds, defaults and unknown fields are explicit',()=>{
  expect(CatalogQuerySchema.parse({query:'  Aurora  '})).toEqual({query:'Aurora',limit:25,offset:0});
  for(const query of [{limit:0},{limit:101},{offset:-1},{offset:10001},{query:'a'.repeat(81)},{private:true}])
    expect(CatalogQuerySchema.safeParse(query).success).toBe(false);
});
