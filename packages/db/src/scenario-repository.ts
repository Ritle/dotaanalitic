import {createHash} from 'node:crypto';
import {ScenarioInputSchema,ScenarioSnapshotSchema,type ScenarioInput,type ScenarioSnapshot,type DraftAssessment} from '@dota/contracts';
import {sql,type Db,type Executor} from './index.js';
import {GameRegistryRepository} from './game-context-repository.js';
import {assessScenarioDraft} from './scenario-draft.js';
export class ScenarioError extends Error {
  constructor(public readonly code:'NOT_FOUND'|'CONFLICT'|'VALIDATION_ERROR'|'DRAFT_UNAVAILABLE',public readonly assessment?:DraftAssessment){super(code);}
}
type Row={id:string;revision:number;input_snapshot:unknown;input_hash:string;recorded_at:Date;draft_assessment:unknown|null};
const snapshot=(r:Row):ScenarioSnapshot=>{
  const input=ScenarioInputSchema.parse(r.input_snapshot),recordedAt=r.recorded_at.toISOString();
  return ScenarioSnapshotSchema.parse({id:r.id,revision:r.revision,input,inputHash:r.input_hash,source:'manual',recordedAt,knownAt:recordedAt,
    eventAt:input.scheduledAt,predictionEligibility:'not_assessed',warnings:['OWNER_ASSERTION_ONLY',...(recordedAt>input.cutoffAt?['RECORDED_AFTER_CUTOFF']:[])],
    ...(r.draft_assessment===null?{}:{draftAssessment:r.draft_assessment})});
};
export class ScenarioRepository {
  constructor(private readonly db:Db){}
  async list(owner:string,offset=0){
    const r=await sql<Row>`SELECT s.id,p.revision,p.input_snapshot,p.input_hash,p.recorded_at,p.draft_assessment FROM scenarios s
      JOIN scenario_input_snapshots p ON p.scenario_id=s.id AND p.revision=s.revision WHERE s.owner_user_id=${owner}::uuid
      ORDER BY s.updated_at DESC,s.id LIMIT 21 OFFSET ${offset}`.execute(this.db);
    return {items:r.rows.slice(0,20).map(snapshot),hasMore:r.rows.length>20};
  }
  async get(owner:string,id:string,executor:Executor=this.db){
    const r=await sql<Row>`SELECT s.id,p.revision,p.input_snapshot,p.input_hash,p.recorded_at,p.draft_assessment FROM scenarios s
      JOIN scenario_input_snapshots p ON p.scenario_id=s.id AND p.revision=s.revision
      WHERE s.id=${id}::uuid AND s.owner_user_id=${owner}::uuid`.execute(executor);
    if(!r.rows[0])throw new ScenarioError('NOT_FOUND');return snapshot(r.rows[0]);
  }
  async history(owner:string,id:string,offset=0){
    await this.get(owner,id);
    const r=await sql<Row>`SELECT s.id,p.revision,p.input_snapshot,p.input_hash,p.recorded_at,p.draft_assessment FROM scenarios s
      JOIN scenario_input_snapshots p ON p.scenario_id=s.id WHERE s.id=${id}::uuid AND s.owner_user_id=${owner}::uuid
      ORDER BY p.revision DESC LIMIT 21 OFFSET ${offset}`.execute(this.db);
    return {items:r.rows.slice(0,20).map(snapshot),hasMore:r.rows.length>20};
  }
  async save(owner:string,raw:ScenarioInput,edit?:{id:string;expectedRevision:number}){
    const parsed=ScenarioInputSchema.parse(raw);
    // Canonical role ordering makes input hashes independent of transport array order.
    const sort=(rows:ScenarioInput['lineupA'])=>[...rows].sort((a,b)=>a.rolePos-b.rolePos);
    const input={...parsed,lineupA:sort(parsed.lineupA),lineupB:sort(parsed.lineupB),
      expectedLineupA:parsed.expectedLineupA?sort(parsed.expectedLineupA):null,expectedLineupB:parsed.expectedLineupB?sort(parsed.expectedLineupB):null,
      ...(parsed.draft?{draft:{assignments:[...parsed.draft.assignments].sort((a,b)=>a.teamSlot.localeCompare(b.teamSlot)||a.rolePos-b.rolePos),
        bans:[...parsed.draft.bans].sort((a,b)=>a.teamSlot.localeCompare(b.teamSlot)||a.heroId-b.heroId)}}:{})};
    return this.db.transaction().execute(async trx=>{
      if(edit){
        const old=await sql<{revision:number}>`SELECT revision FROM scenarios WHERE id=${edit.id}::uuid AND owner_user_id=${owner}::uuid FOR UPDATE`.execute(trx);
        if(!old.rows[0])throw new ScenarioError('NOT_FOUND');
        if(old.rows[0].revision!==edit.expectedRevision)throw new ScenarioError('CONFLICT');
        // An old client must explicitly send the full draft to change/clear it.
        const draft=await sql`SELECT 1 FROM scenario_draft_actions WHERE scenario_id=${edit.id}::uuid
          UNION ALL SELECT 1 FROM scenario_lineup WHERE scenario_id=${edit.id}::uuid AND hero_id IS NOT NULL AND ${input.draft===undefined}
          UNION ALL SELECT 1 FROM scenario_bans WHERE scenario_id=${edit.id}::uuid AND ${input.draft===undefined} LIMIT 1`.execute(trx);
        if(draft.rows.length)throw new ScenarioError('CONFLICT');
      }
      await this.validateReferences(trx,input);
      const assessment=input.draft?await this.assess(trx,input):null;
      if(assessment?.status==='blocked')throw new ScenarioError('DRAFT_UNAVAILABLE',assessment);
      const c=input.context;
      const row=edit?await sql<{id:string;revision:number}>`UPDATE scenarios SET revision=revision+1,title=${input.title},
        team_a_id=${input.teamAId}::bigint,team_b_id=${input.teamBId}::bigint,cutoff_at=${input.cutoffAt}::timestamptz,scheduled_at=${input.scheduledAt}::timestamptz,
        series_id=${c.seriesId}::uuid,map_number=${c.mapNumber},team_a_series_wins_before=${c.teamASeriesWinsBefore},team_b_series_wins_before=${c.teamBSeriesWinsBefore},
        radiant_slot=${c.radiantSlot},first_pick_slot=${c.firstPickSlot},venue_kind=${c.venueKind},tournament_stage=${c.tournamentStage},league_id=${c.leagueId??null}::bigint,updated_at=clock_timestamp()
        WHERE id=${edit.id}::uuid AND owner_user_id=${owner}::uuid AND revision=${edit.expectedRevision} RETURNING id,revision`.execute(trx):
        await sql<{id:string;revision:number}>`INSERT INTO scenarios(owner_user_id,title,team_a_id,team_b_id,cutoff_at,scheduled_at,series_id,map_number,
          team_a_series_wins_before,team_b_series_wins_before,radiant_slot,first_pick_slot,venue_kind,tournament_stage,league_id)
          VALUES (${owner}::uuid,${input.title},${input.teamAId}::bigint,${input.teamBId}::bigint,${input.cutoffAt}::timestamptz,${input.scheduledAt}::timestamptz,
          ${c.seriesId}::uuid,${c.mapNumber},${c.teamASeriesWinsBefore},${c.teamBSeriesWinsBefore},${c.radiantSlot},${c.firstPickSlot},${c.venueKind},${c.tournamentStage},${c.leagueId??null}::bigint) RETURNING id,revision`.execute(trx);
      const saved=row.rows[0];if(!saved)throw new ScenarioError('CONFLICT');
      await sql`DELETE FROM scenario_lineup WHERE scenario_id=${saved.id}::uuid`.execute(trx);
      await sql`DELETE FROM scenario_expected_lineup WHERE scenario_id=${saved.id}::uuid`.execute(trx);
      await sql`DELETE FROM scenario_bans WHERE scenario_id=${saved.id}::uuid`.execute(trx);
      for(const [slot,line,expected] of [['A',input.lineupA,input.expectedLineupA],['B',input.lineupB,input.expectedLineupB]] as const){
        for(const p of line)await sql`INSERT INTO scenario_lineup(scenario_id,team_slot,role_pos,player_id,is_standin,hero_id)
          VALUES (${saved.id}::uuid,${slot},${p.rolePos},${p.playerId}::bigint,${p.isStandin},${input.draft?.assignments.find(h=>h.teamSlot===slot&&h.rolePos===p.rolePos)?.heroId??null})`.execute(trx);
        for(const p of expected??[])await sql`INSERT INTO scenario_expected_lineup(scenario_id,team_slot,role_pos,player_id,confirmed_by_owner,confirmed_at)
          VALUES (${saved.id}::uuid,${slot},${p.rolePos},${p.playerId}::bigint,true,clock_timestamp())`.execute(trx);
      }
      for(const ban of input.draft?.bans??[])await sql`INSERT INTO scenario_bans(scenario_id,team_slot,hero_id)
        VALUES (${saved.id}::uuid,${ban.teamSlot},${ban.heroId})`.execute(trx);
      const body=JSON.stringify(input),hash=createHash('sha256').update(body).digest('hex');
      await sql`INSERT INTO scenario_input_snapshots(scenario_id,revision,input_snapshot,input_hash,draft_assessment)
        VALUES (${saved.id}::uuid,${saved.revision},${body}::jsonb,${hash},${assessment?JSON.stringify(assessment):null}::jsonb)`.execute(trx);
      return this.get(owner,saved.id,trx);
    });
  }
  async checkDraft(raw:ScenarioInput){
    const input=ScenarioInputSchema.parse(raw);
    return this.db.transaction().execute(async trx=>{await this.validateReferences(trx,input);return this.assess(trx,input);});
  }
  private async assess(trx:Executor,input:ScenarioInput){
    // All evidence writers bump this same row in their transaction. Keep the
    // revision/evidence set stable through validation and snapshot insertion.
    await sql`SELECT revision FROM game_context_registry_state WHERE singleton FOR SHARE`.execute(trx);
    const registry=await new GameRegistryRepository(trx).snapshot();
    const now=await sql<{at:Date}>`SELECT clock_timestamp() AS at`.execute(trx);
    return assessScenarioDraft(input,registry,now.rows[0]!.at.toISOString());
  }
  private async validateReferences(trx:Executor,input:ScenarioInput){
    const teams=await sql`SELECT id FROM teams WHERE id IN (${input.teamAId}::bigint,${input.teamBId}::bigint) FOR KEY SHARE`.execute(trx);
    if(teams.rows.length!==2)throw new ScenarioError('VALIDATION_ERROR');
    const ids=[...new Set([input.lineupA,input.lineupB,input.expectedLineupA??[],input.expectedLineupB??[]].flat().map(p=>p.playerId!))];
    const players=await sql`SELECT id FROM players WHERE id IN (${sql.join(ids.map(id=>sql`${id}::bigint`))}) FOR KEY SHARE`.execute(trx);
    if(players.rows.length!==ids.length)throw new ScenarioError('VALIDATION_ERROR');
    const heroIds=[...new Set([...(input.draft?.assignments??[]),...(input.draft?.bans??[])].map(h=>h.heroId))];
    if(heroIds.length){
      const heroes=await sql`SELECT id FROM heroes WHERE id IN (${sql.join(heroIds)}) FOR KEY SHARE`.execute(trx);
      if(heroes.rows.length!==heroIds.length)throw new ScenarioError('VALIDATION_ERROR');
    }
    if(input.context.leagueId){const leagues=await sql`SELECT id FROM leagues WHERE id=${input.context.leagueId}::bigint FOR KEY SHARE`.execute(trx);
      if(!leagues.rows.length)throw new ScenarioError('VALIDATION_ERROR');}
    if(input.context.seriesId){
      const r=await sql<{team_a_id:string;team_b_id:string;best_of:number;league_id:string|null}>`SELECT team_a_id::text,team_b_id::text,best_of,league_id::text FROM series WHERE id=${input.context.seriesId}::uuid FOR SHARE`.execute(trx);
      const s=r.rows[0],c=input.context;
      if(!s||![s.team_a_id,s.team_b_id].includes(input.teamAId)||![s.team_a_id,s.team_b_id].includes(input.teamBId)||
        (s.league_id!==null&&c.leagueId!=null&&s.league_id!==c.leagueId)||
        (c.mapNumber!==null&&c.mapNumber>s.best_of)||
        (c.teamASeriesWinsBefore!==null&&s.best_of!==2&&Math.max(c.teamASeriesWinsBefore,c.teamBSeriesWinsBefore!)>=Math.floor(s.best_of/2)+1))throw new ScenarioError('VALIDATION_ERROR');
    }
  }
}
