import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
const target = new Set(['956962','957770','957814','969607','987711']);
const editions = ['17891','18058','18358'];
const read = async url => {
  const res=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
  assert.equal(res.status,200);
  const bytes=Buffer.from(await res.arrayBuffer());
  assert(bytes.length<16000000);
  return {body:JSON.parse(bytes),fetchedAt:new Date().toISOString(),sha256:createHash('sha256').update(bytes).digest('hex'),url:String(url)};
};
const snapshots=[];
for (const id of editions) {
  const {body,...ref}=await read('https://www.dota2.com/webapi/IDOTA2League/GetLeagueData/v001?league_id='+id+'&delay_seconds=0');
  assert.equal(String(body.info.league_id),id);
  const allowed=['series_id','series_type','team_id_radiant','team_id_dire','team_id_1','team_id_2','team_id_a','team_id_b','start_time','match_ids','node_id','node_group_id','league_node_id'];
  const project=o=>Object.fromEntries(allowed.filter(k=>Object.hasOwn(o,k)).map(k=>[k,o[k]]));
  const graph=[];
  function visit(node) {
    if (!node || typeof node!=='object') return;
    if (Object.hasOwn(node,'node_type') && Object.hasOwn(node,'node_id')) {
      graph.push({nodeId:node.node_id,groupId:node.node_group_id,type:node.node_type,
        seriesId:String(node.series_id??0),teams:[node.team_id_1,node.team_id_2],
        started:node.has_started,completed:node.is_completed,actualTime:node.actual_time,
        games:(node.matches??[]).map(m=>({id:String(m.match_id??0),fields:Object.keys(m)}))});
    }
    for(const value of Object.values(node)) if(typeof value==='object') visit(value);
  }
  visit(body.node_groups);
  snapshots.push({...ref,edition:id,series:body.series_infos.map(project),graph});
}
const url=new URL('https://api.opendota.com/api/explorer');
url.searchParams.set('sql',`SELECT m.match_id::text,m.leagueid::text,m.series_id::text,m.start_time,m.radiant_team_id::text,m.dire_team_id::text
  FROM matches m WHERE m.leagueid IN (17891,18058,18358) OR m.match_id IN (8210712356,8263397852,8345450484)
  ORDER BY m.start_time,m.match_id LIMIT 900`);
const {body,...ref}=await read(url);
assert.equal(body.err,null);
assert(body.rows.length>0 && body.rows.length<900);
const path='.tools/s309-wallachia-series-graph.json';
await writeFile(path,JSON.stringify({snapshots,opendota:{...ref,rows:body.rows}})+'\n',{flag:'wx'});
for(const s of snapshots) console.log(JSON.stringify({edition:s.edition,nodes:s.graph.length,
  selected:s.graph.filter(n=>target.has(n.seriesId)).map(n=>({...n,games:n.games.map(g=>g.id)})),
  gameFields:s.graph.find(n=>n.games.length)?.games[0].fields}));
