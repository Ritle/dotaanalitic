import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
const snapshots=[];
const token=process.env.PANDASCORE_API_TOKEN?.trim();
assert(token,'PandaScore token missing');
for (const edition of ['9121','9264','9362']) {
  const url=new URL('https://api.pandascore.co/dota2/matches/past');
  url.search=new URLSearchParams({'filter[serie_id]':edition,per_page:'100',page:'1'});
  const response=await fetch(url,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200);
  const bytes=Buffer.from(await response.arrayBuffer());
  const data=JSON.parse(bytes);
  assert(data.length>0 && data.length<100 && response.headers.has('x-total') && data.length===Number(response.headers.get('x-total')));
  assert.equal(new Set(data.map(m=>m.id)).size,data.length);
  const rows=data.map(m=>{
    assert.equal(String(m.serie_id),edition);
    return {id:String(m.id),edition,editionName:m.serie.full_name,stageId:String(m.tournament_id),format:m.number_of_games,
      status:m.status,forfeit:m.forfeit??null,teams:m.opponents.map(t=>t.opponent.name),beginAt:m.begin_at,
      games:m.games.map(g=>({position:g.position,beginAt:g.begin_at,status:g.status,forfeit:g.forfeit??null,
        nativeId:g.dota_match_id??g.steam_match_id??null}))};
  });
  snapshots.push({url:url.href,edition,fetchedAt:new Date().toISOString(),total:data.length,
    sha256:createHash('sha256').update(bytes).digest('hex'),rows});
  await delay(1200);
}
await writeFile('.tools/s309-wallachia-edition-registers.json',JSON.stringify(snapshots)+'\n',{flag:'wx'});
console.log(snapshots.map(s=>({edition:s.edition,series:s.rows.length,bo3:s.rows.filter(m=>m.format===3).length,
  forfeited:s.rows.filter(m=>m.forfeit).length})));
