import {sql} from 'kysely';
import {HeroMatchupQuerySchema,type HeroMatchupQuery,type HeroMatchupReport} from '@dota/contracts';
import type {Db} from './index.js';
import {ScenarioRepository,ScenarioError} from './scenario-repository.js';
import {readProMapInventory} from './pro-map-reader.js';
import {PatchMetaRepository} from './patch-meta-repository.js';
import {resolvePatchAt} from './game-context.js';
import {buildHeroMatchupReport} from './hero-matchups.js';
export class HeroMatchupRepository {
  constructor(private readonly db:Db){}
  async report(owner:string,id:string,raw:HeroMatchupQuery){
    const query=HeroMatchupQuerySchema.parse(raw);
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
      const snapshot=await new ScenarioRepository(this.db).get(owner,id,trx);
      if(snapshot.revision!==query.expectedRevision)throw new ScenarioError('CONFLICT');
      const snapshotAt=new Date().toISOString(),cutoffAt=snapshot.input.cutoffAt<snapshotAt?snapshot.input.cutoffAt:snapshotAt;
      const fromAt=query.fromAt??new Date(Math.max(0,Date.parse(cutoffAt)-90*86400000)).toISOString();
      if(fromAt>=cutoffAt)throw new ScenarioError('VALIDATION_ERROR');
      const unavailable=(reason:'WINDOW_TOO_LARGE'|'TARGET_PATCH_UNKNOWN'|'INSUFFICIENT_DRAFT',message:string)=>({status:'unavailable' as const,reason,scenarioId:id,scenarioRevision:snapshot.revision,snapshotAt,cutoffAt,fromAt,message});
      const ids=(snapshot.input.draft?.assignments??[]).map(h=>h.heroId);
      if(ids.length<2)return unavailable('INSUFFICIENT_DRAFT','Назначьте минимум двух героев и сохраните сценарий.');
      if(query.patchId&&!(await sql`SELECT id FROM patches WHERE id=${query.patchId}::bigint`.execute(trx)).rows.length)throw new ScenarioError('VALIDATION_ERROR');
      if(query.leagueId&&!(await sql`SELECT id FROM leagues WHERE id=${query.leagueId}::bigint`.execute(trx)).rows.length)throw new ScenarioError('VALIDATION_ERROR');
      const registry=await new PatchMetaRepository(trx).snapshot();
      if(query.patchScope==='current'&&resolvePatchAt(registry.patches.filter(p=>p.fetchedAt<=snapshotAt),cutoffAt,snapshotAt).value===null)return unavailable('TARGET_PATCH_UNKNOWN','Патч на дату среза не подтверждён. Выберите все патчи или другой срез.');
      const target=sql`EXISTS(SELECT 1 FROM match_players p WHERE p.match_id=m.id AND p.hero_id=ANY(${ids}::int[]))`;
      const inventory=await readProMapInventory(trx,target,fromAt,cutoffAt,snapshotAt);
      if(!inventory)return unavailable('WINDOW_TOO_LARGE','В окне более 5000 карт с выбранными героями. Сузьте период.');
      const reference=await readProMapInventory(trx,target,undefined,fromAt,snapshotAt);
      const names=(await sql<{id:number;localized_name:string}>`SELECT id,localized_name FROM heroes WHERE id=ANY(${ids}::int[])`.execute(trx)).rows;
      return buildHeroMatchupReport(snapshot,query,fromAt,cutoffAt,snapshotAt,inventory.candidates,reference?.candidates??null,registry,new Map(names.map(h=>[h.id,h.localized_name]))) satisfies HeroMatchupReport;
    });
  }
}
