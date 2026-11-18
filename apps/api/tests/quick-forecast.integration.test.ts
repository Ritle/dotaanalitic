import {test,expect,beforeEach,afterEach,vi} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {RosterCatalogueBindingSchema,type UpcomingMatch} from '@dota/contracts';
import {sql,V1PredictionService,PageScheduledPredictionService} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres';
import {seedPredictionScenario} from '../../../tests/helpers/predictions';
import {publishTargetSchedule,syntheticTargetMatch} from '../../../tests/helpers/schedule-target';
import {runtimeFixture} from '../../../packages/db/tests/v1-runtime-fixtures';
import {AuthService} from '../src/modules/auth/service';
import {LineupTemplateRepository} from '../src/modules/catalog/lineup-templates-repository';
import {QuickForecastService} from '../src/modules/upcoming/quick-forecast';
import {UpcomingService} from '../src/modules/upcoming/service';
import {buildApp} from '../src/app';
import {readConfig} from '../src/config';
let database:Awaited<ReturnType<typeof testDatabase>>,owner:string,base:Awaited<ReturnType<typeof seedPredictionScenario>>,match:UpcomingMatch,service:QuickForecastService;
let refresh:ReturnType<typeof vi.fn>,mapping=true;
const scope=()=>runtimeFixture().request.targetScope!;
const request=(manual=true)=>({requestId:randomUUID(),providerTeamAId:'74',providerTeamBId:'75',teamAId:'11',teamBId:'22',lineupA:base.lineupA,lineupB:base.lineupB,...(manual?{tournament:{leagueId:'77',scope:scope()}}:{})});
beforeEach(async()=>{
 database=await testDatabase();base=await seedPredictionScenario(database.db);owner=(await new AuthService(database.db).provision('synthetic-quick-owner',randomBytes(24).toString('hex'))).id;
 match=syntheticTargetMatch({scheduledAt:base.scheduledAt});await publishTargetSchedule(database.db,[match]);mapping=true;
 const templates=new LineupTemplateRepository(database.db);
 for(const [teamId,lineup] of [['11',base.lineupA],['22',base.lineupB]] as const)await templates.save(owner,teamId,{requestId:randomUUID(),expectedRevision:0,confirmedByOwner:true,lineup:lineup.map(p=>({playerId:p.playerId!,rolePos:p.rolePos}))});
 const upcoming=new UpcomingService(database.db);
 refresh=vi.fn(async()=>{await publishTargetSchedule(database.db,[match]);return upcoming.schedule(false,1);});
 const predictions=await PageScheduledPredictionService.open(database.db,await V1PredictionService.open(database.db));
 service=new QuickForecastService(database.db,{schedule:refresh},predictions,{latest:async(_owner,id)=>mapping?RosterCatalogueBindingSchema.parse({
  providerTeamId:id,teamId:id==='74'?'11':'22',teamName:'Synthetic confirmed binding',revision:1,recordedAt:new Date().toISOString(),usable:true,
  players:(id==='74'?base.lineupA:base.lineupB).map(p=>({providerPlayerId:p.playerId,accountId:p.playerId,playerId:p.playerId,name:'Synthetic player',proMaps:0,identityStatus:'unknown'})),
  source:{provider:'local',fetchedAt:new Date().toISOString(),payloadSha256:'a'.repeat(64),rosterFetchedAt:new Date().toISOString(),rosterSha256:'b'.repeat(64)}}):null});
});
afterEach(async()=>{await database?.close();});
const counts=async()=>{
 const r=await sql<{scenarios:number;targets:number;forecasts:number;plans:number}>`SELECT (SELECT count(*)::int FROM scenarios) scenarios,
 (SELECT count(*)::int FROM v1_schedule_targets) targets,(SELECT count(*)::int FROM v1_runtime_snapshots) forecasts,(SELECT count(*)::int FROM upcoming_forecast_preparations) plans`.execute(database.db);return r.rows[0];
};
test('one request prepares and runs first map; exact replay survives started source and freezes input',async()=>{
 const stages:string[]=[];const body=request(),result=await service.run(owner,match.providerMatchId,body,stage=>stages.push(stage));
 expect(stages).toEqual(['request','schedule','lineups','map','analysis','complete']);
 expect(result.forecast.status).toBe('unavailable');expect(result.forecast.teamAWinProbability).toBeNull();expect(result.forecast.reasons).toContain('NO_ACTIVE_MODEL');
 expect(Date.parse(result.forecast.scenario.recordedAt)).toBeLessThan(Date.parse(result.forecast.cutoffAt));
 expect(Date.parse(result.forecast.cutoffAt)).toBeLessThan(Date.parse(match.scheduledAt!));
 expect(result.forecast.scenario.input.context.mapNumber).toBe(1);expect(result.forecast.scenario.input.lineupA).toEqual(base.lineupA);
 expect(refresh).not.toHaveBeenCalled();expect(await counts()).toEqual({scenarios:1,targets:1,forecasts:1,plans:1});
 await publishTargetSchedule(database.db,[{...match,status:'running'}]);expect(await service.run(owner,match.providerMatchId,body)).toEqual(result);
 expect(await counts()).toEqual({scenarios:1,targets:1,forecasts:1,plans:1});
 await expect(service.run(owner,match.providerMatchId,{...body,teamAId:'22'})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
 await expect(sql`DELETE FROM upcoming_forecast_preparations`.execute(database.db)).rejects.toThrow('upcoming_forecast_preparation_immutable');
});
test('concurrent identical requests create one preparation and recovery returns the same forecast',async()=>{
 const body=request();const values=await Promise.allSettled([service.run(owner,match.providerMatchId,body),service.run(owner,match.providerMatchId,body)]);
 expect(values.some(v=>v.status==='fulfilled')).toBe(true);await service.run(owner,match.providerMatchId,body);
 expect(await counts()).toEqual({scenarios:1,targets:1,forecasts:1,plans:1});
});
test('wrong scope, unconfirmed roles and participant changes create no scenario',async()=>{
 const wrong=request();wrong.tournament!.scope.leagueId='78';await expect(service.run(owner,match.providerMatchId,wrong)).rejects.toMatchObject({code:'TOURNAMENT_REQUIRED'});
 const roles=request();roles.lineupA=roles.lineupA.map(p=>({...p,rolePos:6-p.rolePos}));await expect(service.run(owner,match.providerMatchId,roles)).rejects.toMatchObject({code:'LINEUPS_CHANGED'});
 await expect(service.run(owner,match.providerMatchId,{...request(),providerTeamAId:'999'})).rejects.toMatchObject({code:'PARTICIPANTS_CHANGED'});
 mapping=false;await expect(service.run(owner,match.providerMatchId,request())).rejects.toMatchObject({code:'TEAM_MAPPING_REQUIRED'});
 expect(await counts()).toEqual({scenarios:0,targets:0,forecasts:0,plans:0});
});
test('verified exact tournament is reused on a different match; another stage is not inferred from its name',async()=>{
 await service.run(owner,match.providerMatchId,request());
 match={...match,providerMatchId:'9007199254743000'};await publishTargetSchedule(database.db,[match]);
 const next=await service.run(owner,match.providerMatchId,request(false));expect(next.forecast.scenario.input.context.leagueId).toBe('77');
 match={...match,providerMatchId:'9007199254743001',tournament:{...match.tournament,providerTournamentId:'799'}};await publishTargetSchedule(database.db,[match]);
 const unknown=await service.run(owner,match.providerMatchId,request(false));
 expect(unknown.forecast.scenario.input.context.leagueId).toBeNull();
 expect(unknown.forecast.targetScope).toBeNull();
 expect(await counts()).toEqual({scenarios:3,targets:3,forecasts:3,plans:3});
});
test('stale schedule refreshes once; a fresh schedule does not spend an external call',async()=>{
 await publishTargetSchedule(database.db,[match],new Date(Date.now()-360000).toISOString());
 await service.run(owner,match.providerMatchId,request());expect(refresh).toHaveBeenCalledTimes(1);expect(refresh).toHaveBeenCalledWith(true,1);
});
test('HTTP endpoint retains session, origin and CSRF protection',async()=>{
 const app=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://localhost:5173'}),{db:database.db,logger:false});
 try{const url='/api/v1/upcoming/'+match.providerMatchId+'/forecast';
 expect((await app.inject({method:'POST',url,payload:request()})).statusCode).toBe(401);
 const progressUrl='/api/v1/upcoming/'+match.providerMatchId+'/forecast-progress/'+randomUUID();
 expect((await app.inject({url:progressUrl})).statusCode).toBe(401);
 const password=randomBytes(24).toString('hex');await new AuthService(database.db).provision('synthetic-quick-owner',password,true);
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-quick-owner',password}});
 const cookie=login.cookies.map(c=>c.name+'='+c.value).join('; ');
 const progress=await app.inject({url:progressUrl,headers:{cookie}});expect(progress.statusCode).toBe(200);expect(progress.json()).toEqual({progress:null});expect(progress.headers['cache-control']).toBe('no-store');
 expect((await app.inject({method:'POST',url,headers:{cookie,origin:'http://localhost:5173'},payload:request()})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url,headers:{cookie,origin:'https://example.test','x-csrf-token':login.json().csrfToken},payload:request()})).statusCode).toBe(403);
 }finally{await app.close();}
});

test('unclassified event needs no tier assertion or invented local league; model gate remains',async()=>{
 const body=request(false),result=await service.run(owner,match.providerMatchId,body);
 expect(result.forecast.targetScope).toBeNull();
 expect(result.forecast.scenario.input.context.leagueId).toBeNull();
 expect(result.forecast.reasons).toContain('NO_ACTIVE_MODEL');
 expect(result.forecast.reasons).not.toContain('TIER1_SCOPE_NOT_REVIEWED');
 expect(result.forecast.warnings).toContain('TOURNAMENT_TIER_UNVERIFIED');
 expect((await sql`SELECT 1 FROM owner_tier1_scopes`.execute(database.db)).rows).toHaveLength(0);
 await publishTargetSchedule(database.db,[{...match,status:'running'}]);
 expect(await service.run(owner,match.providerMatchId,body)).toEqual(result);
 await expect(service.run(owner,match.providerMatchId,request(false))).rejects.toMatchObject({code:'SCHEDULE_UNAVAILABLE'});
 expect(await counts()).toEqual({scenarios:1,targets:1,forecasts:1,plans:1});
});
