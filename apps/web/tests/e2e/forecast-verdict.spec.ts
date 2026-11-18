import {test,expect} from '@playwright/test';
import {journalViewFixture} from '../../../../tests/helpers/journal-view';
import {V1JournalViewSchema} from '@dota/contracts';
// Synthetic display responses only; no real server, provider calls or persistence.
function fixture(){
 const view=journalViewFixture(),base=view.rows[0]!;
 view.rows=[
  {...base,correct:true},
  {...base,correct:false,actualWinner:'B' as const},
  {...base,status:'pending_verification' as const,correct:null,actualWinner:'B' as const},
  {...base,probability:.5,favourite:null,correct:null},
  {...base,status:'cancelled' as const,correct:null,actualWinner:null},
  {...base,status:'excluded' as const},
  {...base,status:'superseded' as const},
  {...base,sourceChangedSinceRefresh:true}
 ].map((row,i)=>({...row,predictionId:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,scenario:{...row.scenario,title:`Синтетический пример ${i+1}`}}));
 Object.assign(view.summary.metrics,{n:4,accuracyN:3,correct:2,ties:1,accuracy:2/3});
 Object.assign(view.summary.counts,{attempts:8,primaryMaps:4,verifiedMaps:4,pendingVerification:1,unlinked:0,cancelled:1,superseded:1,excluded:1});
 return V1JournalViewSchema.parse(view);
}
test('selected archived report shows explicit verdicts, names and snapshot totals without writes or duplicate label reads',async({page})=>{
 const view=fixture();let labelCalls=0,writes=0;const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/health',route=>route.fulfill({json:{status:'ok',syntheticOnly:true}}));
 await page.route('**/api/v1/**',route=>{
  const request=route.request(),url=new URL(request.url());if(request.method()!=='GET')writes++;
  if(url.pathname==='/api/v1/auth/me')return route.fulfill({json:{owner:{id:view.requestId,login:'synthetic-verdict'},expiresAt:'2099-01-01T00:00:00.000Z',csrfToken:'synthetic'}});
  if(url.pathname==='/api/v1/auth/access')return route.fulfill({json:{role:'owner',canManageLineups:true}});
  if(url.pathname==='/api/v1/catalog-labels'){labelCalls++;expect(url.searchParams.get('teams')?.split(',')).toHaveLength(2);
   return route.fulfill({json:{source:'local_catalogue',readAt:'2026-01-03T00:00:00.000Z',teams:[{id:baseTeam('A'),name:'Synthetic Aurora'},{id:baseTeam('B'),name:'Synthetic Spirit'}],players:[]}});}
  if(url.pathname==='/api/v1/forecast-journal')return route.fulfill({json:{items:[{requestId:view.requestId,revision:view.revision,sha256:view.sha256,capturedAt:view.capturedAt,filters:view.summary.filters,n:view.summary.metrics.n,accuracy:view.summary.metrics.accuracy}],nextBeforeRevision:null}});
  if(url.pathname==='/api/v1/forecast-journal/'+view.requestId)return route.fulfill({json:view});
  return route.fulfill({status:404,json:{error:{code:'SYNTHETIC_UNEXPECTED_REQUEST'}}});
 });
 function baseTeam(side:'A'|'B'){return side==='A'?view.rows[0]!.scenario.teamAId:view.rows[0]!.scenario.teamBId;}
 await page.goto('/forecast-journal?report='+view.requestId);await expect(page).toHaveURL(new RegExp('report='+view.requestId));
 const card=(n:number)=>page.getByRole('row',{name:`Прогноз: Синтетический пример ${n}`,exact:true});
 await expect(card(1).getByRole('heading',{name:'Прогноз верен',exact:true})).toBeVisible();
 await expect(card(2).getByRole('heading',{name:'Прогноз неверен',exact:true})).toBeVisible();
 await expect(card(1)).toContainText('Synthetic Aurora');await expect(card(2)).toContainText('Synthetic Spirit');
 await expect(card(3)).toContainText('Ожидает результата');await expect(card(3)).toContainText('Не подтверждён');await expect(card(3)).not.toContainText('Synthetic Spirit');await expect(card(4)).toContainText('Фаворит не выбран');
 await expect(card(5)).toContainText('Встреча отменена');await expect(card(6)).toContainText('Не оценивается');
 await expect(card(7)).toContainText('не учитывается');await expect(card(8)).toContainText('Нужна повторная проверка');
 await expect(page.getByRole('region',{name:'Итоги прогнозов'})).toContainText('Неверных прогнозов');
 const verdictY=(await card(1).boundingBox())!.y,formY=(await page.getByRole('region',{name:'Новый отчёт журнала'}).boundingBox())!.y;expect(verdictY).toBeLessThan(formY);
 expect((await card(2).boundingBox())!.y).toBeGreaterThan(verdictY);
 await page.screenshot({path:'.tools/s307-table-desktop.png',fullPage:true});
 await page.setViewportSize({width:360,height:800});await card(2).scrollIntoViewIfNeeded();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await expect(card(2).getByRole('heading',{name:'Прогноз неверен',exact:true})).toBeVisible();await page.screenshot({path:'.tools/s307-table-mobile.png'});
 await card(1).getByText('Составы, причины и сведения о прогнозе',{exact:true}).click();await expect(card(1)).toContainText('Состав: Совпал');
 expect(labelCalls).toBe(1);expect(writes).toBe(0);expect(errors).toEqual([]);
});
