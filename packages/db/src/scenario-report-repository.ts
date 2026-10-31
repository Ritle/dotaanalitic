import {createHash,randomUUID} from 'node:crypto';
import {heroMetaSample} from '@dota/analytics';
import {sql} from 'kysely';
import {ScenarioReportQuerySchema,ScenarioReportBodySchema,ScenarioReportSchema,ScenarioReportHistorySchema,PlayerHeroQuerySchema,
  type ScenarioReportQuery,type ScenarioReportBody,type ScenarioReport} from '@dota/contracts';
import type {Db} from './index.js';
import {ScenarioRepository,ScenarioError} from './scenario-repository.js';
import {readProMapInventory} from './pro-map-reader.js';
import {readAccountEvidence} from './identity-repository.js';
import {readStrengthHistory} from './strength-repository.js';
import {PatchMetaRepository} from './patch-meta-repository.js';
import {buildCompareReport} from './compare-report.js';
import {buildRosterReport} from './roster-report.js';
import {buildPlayerHeroReport} from './player-hero-report.js';
import {buildHeroMatchupReport,preparePairMaps} from './hero-matchups.js';
import {resolvePatchAt} from './game-context.js';
import {canonicalContextJson} from './temporal.js';
const digest=(v:unknown)=>createHash('sha256').update(canonicalContextJson(v)).digest('hex');
type SavedRow={id:string;report_version:number;created_at:Date;result_hash:string;result:unknown};
function saved(row:SavedRow):ScenarioReport{
  const report=ScenarioReportBodySchema.parse(row.result);
  if(digest(report)!==row.result_hash)throw new Error('scenario_report_integrity_error');
  return ScenarioReportSchema.parse({id:row.id,version:row.report_version,createdAt:row.created_at.toISOString(),resultHash:row.result_hash,report});
}
export class ScenarioReportRepository{
  constructor(private readonly db:Db){}
  async create(owner:string,scenarioId:string,raw:ScenarioReportQuery){
    const query=ScenarioReportQuerySchema.parse(raw);
    for(let attempt=0;attempt<5;attempt++){
      try{return await this.createSnapshot(owner,scenarioId,query);}
      catch(error){if(!(typeof error==='object'&&error!==null&&'code' in error&&error.code==='40001'))throw error;}
    }
    throw new ScenarioError('CONFLICT');
  }
  private async createSnapshot(owner:string,scenarioId:string,query:ScenarioReportQuery){
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
      // Serialize scenario saves and version allocation; all readers share one DB snapshot.
      const lock=(await sql<{revision:number}>`SELECT revision FROM scenarios WHERE id=${scenarioId}::uuid AND owner_user_id=${owner}::uuid FOR UPDATE`.execute(trx)).rows[0];
      if(!lock)throw new ScenarioError('NOT_FOUND');if(lock.revision!==query.expectedRevision)throw new ScenarioError('CONFLICT');
      const scenario=await new ScenarioRepository(this.db).get(owner,scenarioId,trx),snapshotAt=new Date().toISOString();
      const cutoffAt=scenario.input.cutoffAt<snapshotAt?scenario.input.cutoffAt:snapshotAt,
        fromAt=query.fromAt??new Date(Math.max(0,Date.parse(cutoffAt)-90*86400000)).toISOString();
      if(fromAt>=cutoffAt)throw new ScenarioError('VALIDATION_ERROR');
      if(query.patchId&&!(await sql`SELECT id FROM patches WHERE id=${query.patchId}::bigint`.execute(trx)).rows.length)throw new ScenarioError('VALIDATION_ERROR');
      if(query.leagueId&&!(await sql`SELECT id FROM leagues WHERE id=${query.leagueId}::bigint`.execute(trx)).rows.length)throw new ScenarioError('VALIDATION_ERROR');
      const registry=await new PatchMetaRepository(trx).snapshot(),current=resolvePatchAt(registry.patches.filter(p=>p.fetchedAt<=snapshotAt),cutoffAt,snapshotAt).value;
      if(query.patchScope==='current'&&current===null)return {status:'unavailable' as const,reason:'TARGET_PATCH_UNKNOWN' as const,message:'Патч на дату среза не подтверждён. Выберите все патчи.'};
      const patchId=query.patchScope==='specific'?query.patchId!:query.patchScope==='current'?current:null;
      const inventory=await readProMapInventory(trx,sql`TRUE`,fromAt,cutoffAt,snapshotAt);
      if(!inventory)return {status:'unavailable' as const,reason:'WINDOW_TOO_LARGE' as const,message:'В периоде больше 5000 карт. Сузьте период: неполный отчёт не сохраняется.'};
      const reference=await readProMapInventory(trx,sql`TRUE`,undefined,fromAt,snapshotAt);
      const input=scenario.input,selected=[...new Set([...input.lineupA,...input.lineupB,...input.expectedLineupA??[],...input.expectedLineupB??[]].flatMap(p=>p.playerId??[]))];
      const accounts=(await sql<{account:string}>`SELECT external_account_id AS account FROM player_account_evidence WHERE player_id=ANY(${selected}::bigint[])
        UNION SELECT external_account_id FROM player_external_accounts WHERE player_id=ANY(${selected}::bigint[])
        UNION SELECT opendota_account_id::text FROM players WHERE id=ANY(${selected}::bigint[]) AND opendota_account_id IS NOT NULL`.execute(trx)).rows.map(r=>r.account);
      const evidence=[...new Map([...inventory.evidence,...await readAccountEvidence(trx,accounts)].map(e=>[e.observationId,e])).values()];
      const teams=(await sql<{id:string;name:string}>`SELECT id,name FROM teams WHERE id=ANY(${[input.teamAId,input.teamBId]}::bigint[])`.execute(trx)).rows;
      const heroRows=(await sql<{id:number;localized_name:string}>`SELECT id,localized_name FROM heroes ORDER BY id`.execute(trx)).rows,
        heroNames=new Map(heroRows.map(h=>[String(h.id),h.localized_name]));
      const compareInput={teamAId:input.teamAId,teamBId:input.teamBId,lineupA:input.lineupA,lineupB:input.lineupB,fromAt,cutoffAt,patchId:patchId??undefined,leagueId:query.leagueId};
      const strength=await readStrengthHistory(trx,cutoffAt,snapshotAt);
      const comparison=buildCompareReport(compareInput,snapshotAt,inventory.candidates,evidence,registry,inventory.identityRevision,new Map(teams.map(t=>[t.id,t.name])),strength);
      const filtered=inventory.candidates.filter(m=>(!query.leagueId||m.leagueId===query.leagueId)&&(patchId===null||resolvePatchAt(registry.patches.filter(p=>p.fetchedAt<=snapshotAt),m.startedAt,snapshotAt).value===patchId));
      for(const [team,expected,lineup,id] of [[comparison.teamA,input.expectedLineupA,input.lineupA,input.teamAId],[comparison.teamB,input.expectedLineupB,input.lineupB,input.teamBId]] as const)
        if(expected)team.cohesion=buildRosterReport(id,{lineup,expectedLineup:expected,fromAt,cutoffAt},cutoffAt,snapshotAt,filtered,evidence,registry,inventory.identityRevision);
      const players:ScenarioReportBody['players']=[];
      for(const [teamSlot,lineup] of [['A',input.lineupA],['B',input.lineupB]] as const)for(const p of lineup){
        if(p.playerId===null)throw new ScenarioError('VALIDATION_ERROR');
        const hero=input.draft?.assignments.find(h=>h.teamSlot===teamSlot&&h.rolePos===p.rolePos)?.heroId??null;
        const side=input.context.radiantSlot===null?undefined:input.context.radiantSlot===teamSlot?'radiant':'dire';
        const q=PlayerHeroQuerySchema.parse({fromAt,cutoffAt,patchScope:query.patchScope,patchId:query.patchId,leagueId:query.leagueId,rolePos:p.rolePos,heroId:hero===null?undefined:String(hero),side});
        players.push({teamSlot,rolePos:p.rolePos,playerId:p.playerId,heroId:hero,heroName:hero===null?null:heroNames.get(String(hero))??null,
          report:buildPlayerHeroReport(p.playerId,{...q,fromAt,cutoffAt},snapshotAt,inventory.candidates,evidence,registry,inventory.identityRevision,heroNames,
            reference?{candidates:reference.candidates,evidence:reference.evidence}:null,'GLOBAL_REFERENCE_TOO_LARGE')});
      }
      const ids=(input.draft?.assignments??[]).map(h=>h.heroId),withHeroes=(rows:typeof inventory.candidates)=>rows.filter(m=>m.players.some(p=>p.heroId!=null&&ids.includes(p.heroId)));
      const pairs:ScenarioReportBody['pairs']=ids.length<2?{status:'unavailable',reason:'INSUFFICIENT_DRAFT',scenarioId,scenarioRevision:scenario.revision,snapshotAt,cutoffAt,fromAt,message:'Назначьте минимум двух героев для пар.'}:
        buildHeroMatchupReport(scenario,query,fromAt,cutoffAt,snapshotAt,withHeroes(inventory.candidates),reference?withHeroes(reference.candidates):null,registry,new Map(heroRows.map(h=>[h.id,h.localized_name])));
      const prepared=preparePairMaps(inventory.candidates,{fromAt,cutoffAt,patchId,leagueId:query.leagueId},snapshotAt,registry);
      const included=new Set(prepared.maps.map(m=>m.matchId));
      const report=ScenarioReportBodySchema.parse({policyVersion:'scenario-report-v1',scope:'retrospective_descriptive',status:comparison.status,scenario,query,fromAt,cutoffAt,snapshotAt,effectivePatchId:patchId,
        lineupEvidence:{source:'owner_assertion',recordedAt:scenario.recordedAt,historicalAvailability:'unverified'},comparison,players,pairs,
        heroMeta:ids.map(heroId=>({heroId,name:heroNames.get(String(heroId))??`Герой #${heroId}`,...heroMetaSample(prepared.maps,heroId)})),
        coverage:{candidates:inventory.candidates.length,eligibleProMaps:prepared.coverage.eligibleMaps,unknownPatchMaps:prepared.coverage.unknownPatchMaps,unknownSeriesMaps:prepared.coverage.unverifiedSeriesMaps,
          partialHeroMaps:prepared.coverage.partialHeroMaps,sourceFetchUnknown:prepared.maps.filter(m=>m.sourceFetchedAt===null).length,lateFetchedMaps:prepared.coverage.lateFetchedMaps},
        provenance:{identityRevision:inventory.identityRevision,registryRevision:registry.revision,registryFingerprint:digest(registry),referenceFingerprint:reference?digest({candidates:reference.candidates,evidence:reference.evidence}):null,
          strengthFingerprint:strength?digest(strength):null,referenceStatus:reference?'ready':'unavailable',
          maps:inventory.candidates.map(({matchId,startedAt,isPro,completed,conflict,dataRevision,source,syncedAt,sourceFetchedAt})=>({matchId,startedAt,included:included.has(matchId),isPro,completed,conflict,dataRevision,source,syncedAt,sourceFetchedAt}))},
        prediction:{status:'unavailable',model:null,teamAWinProbability:null,reasons:['MODEL_NOT_READY','S1_07_EMPIRICAL_GATE_OPEN']},
        warnings:['RETROSPECTIVE_NOT_HISTORICAL_FEATURES','OWNER_LINEUP_NOT_VERIFIED_PRE_MAP',...(cutoffAt!==input.cutoffAt?['FUTURE_CUTOFF_CLAMPED']:[]),...(!reference?['REFERENCE_TOO_LARGE']:[])]});
      const version=(await sql<{n:number}>`UPDATE scenarios SET report_version_counter=report_version_counter+1 WHERE id=${scenarioId}::uuid RETURNING report_version_counter AS n`.execute(trx)).rows[0]!.n;
      const resultHash=digest(report),body=JSON.stringify(report);
      const row=(await sql<SavedRow>`INSERT INTO analysis_runs(id,scenario_id,scenario_revision,report_version,input_hash,data_revision,algorithm_version,status,filters,result,coverage,warnings,computed_at,result_hash)
        VALUES(${randomUUID()}::uuid,${scenarioId}::uuid,${scenario.revision},${version},${scenario.inputHash},${digest(report.provenance)},'scenario-report-v1','done',${JSON.stringify(query)}::jsonb,
          ${body}::jsonb,${JSON.stringify(report.coverage)}::jsonb,${JSON.stringify(report.warnings)}::jsonb,${snapshotAt}::timestamptz,${resultHash})
        RETURNING id,report_version,created_at,result_hash,result`.execute(trx)).rows[0]!;
      return saved(row);
    });
  }
  async get(owner:string,id:string){
    const row=(await sql<SavedRow>`SELECT a.id,a.report_version,a.created_at,a.result_hash,a.result FROM analysis_runs a JOIN scenarios s ON s.id=a.scenario_id
      WHERE a.id=${id}::uuid AND s.owner_user_id=${owner}::uuid AND a.report_version IS NOT NULL`.execute(this.db)).rows[0];
    if(!row)throw new ScenarioError('NOT_FOUND');return saved(row);
  }
  async history(owner:string,id:string,offset=0){
    await new ScenarioRepository(this.db).get(owner,id);
    const rows=(await sql<{id:string;report_version:number;scenario_revision:number;created_at:Date;result_hash:string;algorithm_version:string;status:string;from_at:string;cutoff_at:string}>`
      SELECT a.id,a.report_version,a.scenario_revision,a.created_at,a.result_hash,a.algorithm_version,a.result->>'status' AS status,
        a.result->>'fromAt' AS from_at,a.result->>'cutoffAt' AS cutoff_at FROM analysis_runs a JOIN scenarios s ON s.id=a.scenario_id
      WHERE a.scenario_id=${id}::uuid AND s.owner_user_id=${owner}::uuid AND a.report_version IS NOT NULL ORDER BY a.report_version DESC LIMIT 21 OFFSET ${offset}`.execute(this.db)).rows;
    return ScenarioReportHistorySchema.parse({items:rows.slice(0,20).map(r=>({id:r.id,version:r.report_version,scenarioRevision:r.scenario_revision,createdAt:r.created_at.toISOString(),resultHash:r.result_hash,
      policyVersion:r.algorithm_version,status:r.status,fromAt:r.from_at,cutoffAt:r.cutoff_at})),hasMore:rows.length>20});
  }
}
