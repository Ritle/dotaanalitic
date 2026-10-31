import {sql,GameRegistryRepository,type Db} from '../../packages/db/src/index.js';
import {seedStrength} from './strength.js';
import {scenarioInput} from './scenario.js';
export function draftInput(){const q=scenarioInput();q.scheduledAt=q.cutoffAt;q.context.leagueId='1';q.draft={assignments:[],bans:[]};return q;}
/** Synthetic only: isolated tests; no production evidence/hero metadata is seeded. */
export async function seedDraft(db:Db){
  await seedStrength(db);
  await sql`INSERT INTO heroes(id,internal_name,localized_name) SELECT n,'synthetic_draft_'||n,'Synthetic Draft Hero '||n FROM generate_series(2,14) n`.execute(db);
  await sql`INSERT INTO leagues(id,name) VALUES (1,'Synthetic draft league')`.execute(db);
  await sql`INSERT INTO patches(id,label,released_at) VALUES (1,'synthetic draft patch','2023-01-01')`.execute(db);
  await new GameRegistryRepository(db).appendPatch({patchId:'1',releasedAt:'2023-01-01T00:00:00.000Z',coverageUntil:'2025-01-01T00:00:00.000Z',
    eventAt:null,knownAt:'2023-01-01T00:00:00.000Z',fetchedAt:'2026-10-31T00:00:00.000Z',source:'synthetic',evidenceRef:'synthetic:draft-patch',reviewState:'accepted'});
}
export async function draftRule(db:Db,heroId:number,allowed:boolean,options:{knownAt?:string;reviewState?:'accepted'|'conflict'|'unverified';ref?:string}={}){
  return new GameRegistryRepository(db).appendHeroRule({heroId,allowed,patchId:'1',leagueId:'1',validFrom:'2023-01-01T00:00:00.000Z',validTo:null,eventAt:null,
    knownAt:options.knownAt??'2023-01-01T00:00:00.000Z',fetchedAt:'2026-10-31T00:00:00.000Z',source:'synthetic',evidenceRef:options.ref??`synthetic:draft-hero-${heroId}-${allowed}`,reviewState:options.reviewState??'accepted'});
}
