import {createHash} from 'node:crypto';
import {z} from 'zod';
import {OpenDotaClient,type ProviderObservation} from './client.js';
import {TeamMatchesSchema,HeroesSchema,LeaguesSchema,MatchSourceSchema,ProviderIdSchema} from './schemas.js';
import {parseSource,completedObservation,matchEventAt,classifyLeague} from '../quality.js';
const Time=z.iso.datetime({precision:3}),Sha=z.string().regex(/^[a-f0-9]{64}$/);
const TeamIds=z.array(ProviderIdSchema).min(1).max(5).refine(ids=>new Set(ids).size===ids.length);
const Source=z.object({provider:z.literal('opendota'),adapterVersion:z.string().min(1).max(120),endpoint:z.string(),
  fetchedAt:Time,knownAt:z.null(),payloadSha256:Sha,attempts:z.number().int().min(1).max(3),
  rateLimitRemaining:z.object({minute:z.number().nonnegative().nullable(),day:z.number().nonnegative().nullable(),month:z.number().nonnegative().nullable()})});
const Observation=z.object({rawBody:z.string().max(16*1024*1024),source:Source}).strict();
const ErrorRow=z.object({matchId:ProviderIdSchema,code:z.string().regex(/^[a-z_]{1,80}$/),status:z.number().int().nullable()}).strict();
const Capture=z.object({schemaVersion:z.literal(1),mode:z.literal('live_current_history_capture'),cutoffAt:Time,capturedAt:Time,
  teamIds:TeamIds,sample:z.number().int().min(1).max(50),discoveries:z.array(Observation).min(1).max(5),heroes:Observation,
  leagues:Observation,matches:z.array(Observation).max(50),errors:z.array(ErrorRow).max(50)}).strict();
export type CurrentHistoryCapture=z.infer<typeof Capture>;
function decode<T>(observation:z.infer<typeof Observation>,endpoint:string,schema:z.ZodType<T>):ProviderObservation<T>{
  if(observation.source.endpoint!==endpoint||createHash('sha256').update(observation.rawBody).digest('hex')!==observation.source.payloadSha256)
    throw new Error('history_source_binding');
  const raw:unknown=JSON.parse(observation.rawBody);
  if(raw&&typeof raw==='object'&&('synthetic' in raw||'_fixture' in raw))throw new Error('history_synthetic_source');
  return {...observation,data:schema.parse(raw)};
}
type Discovery={teamId:string;data:z.infer<typeof TeamMatchesSchema>};
/** Recent-first round robin by numeric organization. Selection never depends on who won or data quality. */
export function selectCurrentTeamMaps(discoveries:readonly Discovery[],sample:number,cutoffAt:string){
  z.number().int().min(1).max(50).parse(sample);Time.parse(cutoffAt);TeamIds.parse(discoveries.map(d=>d.teamId));
  let invalid=0,duplicates=0,outsideCohort=0;
  const lists=discoveries.map(d=>{const seen=new Set<string>();
    const rows=TeamMatchesSchema.parse(d.data).filter(m=>{
      if(seen.has(m.match_id)){duplicates++;return false;}seen.add(m.match_id);
      if(!m.start_time||!m.duration||typeof m.radiant_win!=='boolean'){invalid++;return false;}
      if((m.start_time+m.duration)*1000>=Date.parse(cutoffAt)){outsideCohort++;return false;}return true;
    }).sort((a,b)=>b.start_time!-a.start_time!||(BigInt(a.match_id)>BigInt(b.match_id)?-1:1));
    return {teamId:d.teamId,rows};});
  const selected:({match_id:string;leagueid?:string|null;discoveryTeamIds:string[]})[]=[],seen=new Set<string>();
  for(let rank=0;selected.length<sample&&lists.some(l=>l.rows.length>rank);rank++)for(const list of lists){
    const row=list.rows[rank];if(!row||seen.has(row.match_id)||selected.length>=sample)continue;
    seen.add(row.match_id);selected.push({match_id:row.match_id,leagueid:row.leagueid,
      discoveryTeamIds:lists.filter(l=>l.rows.some(m=>m.match_id===row.match_id)).map(l=>l.teamId)});
  }
  return {selected,candidates:new Set(lists.flatMap(l=>l.rows.map(r=>r.match_id))).size,duplicates,invalid,outsideCohort,
    teamIds:discoveries.map(d=>d.teamId),method:'recent_completed_round_robin_by_numeric_team'};
}
/** Full raw replay validation before any canonical DB writes. Unknown coverage stays separate from outcome eligibility. */
export function validateCurrentHistoryCapture(input:unknown,observedAt=new Date().toISOString()){
  const capture=Capture.parse(input);Time.parse(observedAt);
  const observations=[...capture.discoveries,capture.heroes,capture.leagues,...capture.matches];
  if(capture.cutoffAt>capture.capturedAt||capture.capturedAt>observedAt||observations.some(o=>o.source.fetchedAt<capture.cutoffAt||o.source.fetchedAt>capture.capturedAt))
    throw new Error('history_capture_clocks');
  if(capture.discoveries.length!==capture.teamIds.length)throw new Error('history_discovery_scope');
  const discoveries=capture.teamIds.map((teamId,i)=>({teamId,...decode(capture.discoveries[i]!,`/teams/${teamId}/matches`,TeamMatchesSchema)}));
  const selection=selectCurrentTeamMaps(discoveries,capture.sample,capture.cutoffAt);
  const heroes=decode(capture.heroes,'/heroes',HeroesSchema),leagues=decode(capture.leagues,'/leagues',LeaguesSchema);
  const matches=capture.matches.map(o=>{const id=o.source.endpoint.match(/^\/matches\/([1-9]\d*)$/)?.[1];
    if(!id)throw new Error('history_match_endpoint');const observation=decode(o,`/matches/${id}`,MatchSourceSchema);
    const parsed=parseSource(observation,id),candidate=selection.selected.find(s=>s.match_id===id);
    if(!candidate)throw new Error('history_match_outside_selection');
    const m=parsed.match,league=m?.leagueid?leagues.data.filter(l=>l.leagueid===m.leagueid):[],reasons:string[]=[];
    const expected=discoveries.flatMap(d=>d.data.filter(row=>row.match_id===id).map(row=>({teamId:d.teamId,row})));
    if(!m)reasons.push('SOURCE_SCHEMA_INVALID');
    else{
      if(!completedObservation(m,capture.cutoffAt)||typeof m.radiant_win!=='boolean')reasons.push('COMPLETED_OUTCOME_REQUIRED');
      if(league.length!==1||classifyLeague(league[0]?.tier)!==true)reasons.push('PRO_LEAGUE_REQUIRED');
      if(![m.radiant_team_id,m.dire_team_id].some(t=>t!=null&&capture.teamIds.includes(t)))reasons.push('TARGET_ORGANIZATION_MISSING');
      if(expected.some(({teamId,row})=>row.leagueid!=null&&m.leagueid!==row.leagueid||row.start_time!==m.start_time||
        row.radiant_win!==m.radiant_win||row.duration!==m.duration||
        row.radiant===true&&m.radiant_team_id!==teamId||row.radiant===false&&m.dire_team_id!==teamId||
        row.opposing_team_id!=null&&row.opposing_team_id!==(m.radiant_team_id===teamId?m.dire_team_id:m.radiant_team_id)||
        ![m.radiant_team_id,m.dire_team_id].includes(teamId)))reasons.push('DISCOVERY_DETAIL_CONFLICT');
    }
    return {matchId:id,observation,match:m,startedAt:matchEventAt(m),eligible:reasons.length===0,reasons};
  });
  const found=[...matches.map(m=>m.matchId),...capture.errors.map(e=>e.matchId)];
  if(new Set(found).size!==found.length||found.length!==selection.selected.length||selection.selected.some(s=>!found.includes(s.match_id)))
    throw new Error('history_match_inventory');
  return {capture,selection,discoveries,heroes,leagues,matches};
}
type Provider=Pick<OpenDotaClient,'getTeamMatches'|'getHeroes'|'getLeagues'|'getMatchSource'>;
export async function captureCurrentHistory(provider:Provider,teamIds:readonly string[],sample:number){
  const ids=TeamIds.parse(teamIds);z.number().int().min(1).max(50).parse(sample);
  const cutoffAt=new Date().toISOString(),discoveries=[];
  for(const teamId of ids)discoveries.push({teamId,...await provider.getTeamMatches(teamId)});
  const heroes=await provider.getHeroes(),leagues=await provider.getLeagues(),selection=selectCurrentTeamMaps(discoveries,sample,cutoffAt);
  const matches:ProviderObservation<unknown>[]=[],errors:z.infer<typeof ErrorRow>[]=[];
  for(const candidate of selection.selected)try{matches.push(await provider.getMatchSource(candidate.match_id));}
  catch(e){errors.push({matchId:candidate.match_id,code:e instanceof Error&&'code' in e&&typeof e.code==='string'&&/^[a-z_]{1,80}$/.test(e.code)?e.code:'history_source_error',
    status:e instanceof Error&&'status' in e&&typeof e.status==='number'?e.status:null});}
  const stored=(o:ProviderObservation<unknown>)=>({source:o.source,rawBody:o.rawBody});
  return Capture.parse({schemaVersion:1,mode:'live_current_history_capture',cutoffAt,capturedAt:new Date().toISOString(),teamIds:ids,sample,
    discoveries:discoveries.map(stored),heroes:stored(heroes),leagues:stored(leagues),matches:matches.map(stored),errors});
}
