import {accountAccess} from '../src/auth';
import {afterEach,expect,test,vi} from 'vitest';
import {CatalogRequestError,readCatalog} from '../src/catalog';

afterEach(()=>vi.unstubAllGlobals());
const schema={parse:(v:unknown)=>v};
const path='upcoming/1791664/catalogue/apply';
test.each([
 [409,'CATALOGUE_CONFLICT','Перечитайте связи'],
 [409,'CATALOGUE_SOURCE_CHANGED','Обновите составы'],
 [503,'CATALOGUE_SOURCE_UNAVAILABLE','Повторите позже'],
 [400,'CATALOGUE_INVALID','пять разных аккаунтов'],
] as const)('catalogue HTTP %s uses safe action-specific message for %s',async(status,code,message)=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{code,message:'untrusted provider secret'}},{status})));
 const error=await readCatalog(path,schema,new AbortController().signal).catch((e:unknown)=>e);
 expect(error).toBeInstanceOf(CatalogRequestError);expect(error).toMatchObject({status,code});
 expect((error as Error).message).toContain(message);expect((error as Error).message).not.toContain('secret');
 expect((error as Error).message).not.toContain('Сценарий');
});
test.each(['<html>upstream secret</html>',JSON.stringify({error:{code:'UNTRUSTED',message:'upstream secret'}})])('unknown or non-JSON catalogue conflict keeps a safe roster fallback',async body=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(body,{status:409})));
 await expect(readCatalog(path,schema,new AbortController().signal)).rejects.toThrow('Перечитайте связи');
});
test('scenario conflict retains its existing editor message',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{code:'CATALOGUE_CONFLICT'}},{status:409})));
 await expect(readCatalog('scenarios/1',schema,new AbortController().signal)).rejects.toThrow('Сценарий уже изменён');
});

test('a server owner-required response removes stale editing access without echoing provider text',async()=>{
 accountAccess.value={role:'owner',canManageLineups:true};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{code:'OWNER_REQUIRED',message:'untrusted secret'}},{status:403})));
 await expect(readCatalog('teams/1/lineup-template',schema,new AbortController().signal)).rejects.toMatchObject({status:403,code:'OWNER_REQUIRED',message:'Изменять составы и роли может только владелец.'});
 expect(accountAccess.value).toBeNull();
});
test('template conflicts describe template reread rather than changing a scenario',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{message:'untrusted secret'}},{status:409})));
 await expect(readCatalog('teams/1/lineup-template',schema,new AbortController().signal)).rejects.toMatchObject({status:409,code:'LINEUP_TEMPLATE_CONFLICT',message:expect.stringContaining('Перечитайте шаблон')});
});
