import {createHash} from 'node:crypto';
import {sql} from 'kysely';
import {PatchTransitionEvidenceSchema,HeroImpactEvidenceSchema,type PatchTransitionEvidence,type HeroImpactEvidence,type PatchHistoryRequest} from '@dota/contracts';
import type {Db,Executor} from './index.js';
import {GameRegistryRepository} from './game-context-repository.js';
import {canonicalContextJson} from './temporal.js';
import {resolveHistoryWeights,type PatchMetaRegistry} from './patch-history.js';
type Common={id:string;patch_id:string;event_at:Date;known_at:Date;fetched_at:Date;source:string;evidence_ref:string;review_state:PatchTransitionEvidence['reviewState']};
const common=(r:Common)=>({id:r.id,patchId:r.patch_id,eventAt:r.event_at.toISOString(),knownAt:r.known_at.toISOString(),fetchedAt:r.fetched_at.toISOString(),source:r.source,evidenceRef:r.evidence_ref,reviewState:r.review_state});
/** Trusted reviewed-evidence boundary; no automatic promotion of provider data. */
export class PatchMetaRepository{
  constructor(private readonly db:Executor){}
  async appendTransition(input:PatchTransitionEvidence){
    const r=PatchTransitionEvidenceSchema.parse(input),digest=createHash('sha256').update(canonicalContextJson(r)).digest('hex');
    await sql`INSERT INTO patch_transition_evidence(from_patch_id,patch_id,change_level,event_at,known_at,fetched_at,source,evidence_ref,review_state,evidence_sha256)
      VALUES (${r.fromPatchId},${r.patchId},${r.changeLevel},${r.eventAt},${r.knownAt},${r.fetchedAt},${r.source},${r.evidenceRef},${r.reviewState},${digest}) ON CONFLICT DO NOTHING`.execute(this.db);
    return (await sql<{id:string}>`SELECT id FROM patch_transition_evidence WHERE evidence_sha256=${digest}`.execute(this.db)).rows[0]!.id;
  }
  async appendHeroImpact(input:HeroImpactEvidence){
    const r=HeroImpactEvidenceSchema.parse(input),digest=createHash('sha256').update(canonicalContextJson(r)).digest('hex');
    await sql`INSERT INTO hero_impact_evidence(patch_id,hero_id,impact_level,event_at,known_at,fetched_at,source,evidence_ref,review_state,evidence_sha256)
      VALUES (${r.patchId},${r.heroId},${r.impactLevel},${r.eventAt},${r.knownAt},${r.fetchedAt},${r.source},${r.evidenceRef},${r.reviewState},${digest}) ON CONFLICT DO NOTHING`.execute(this.db);
    return (await sql<{id:string}>`SELECT id FROM hero_impact_evidence WHERE evidence_sha256=${digest}`.execute(this.db)).rows[0]!.id;
  }
  /** Must be called within the caller's repeatable-read transaction. */
  async snapshot():Promise<PatchMetaRegistry>{
    const registry=await new GameRegistryRepository(this.db).snapshot();
    const ts=(await sql<Common&{from_patch_id:string;change_level:PatchTransitionEvidence['changeLevel']}>`SELECT * FROM patch_transition_evidence ORDER BY id`.execute(this.db)).rows;
    const hs=(await sql<Common&{hero_id:number;impact_level:HeroImpactEvidence['impactLevel']}>`SELECT * FROM hero_impact_evidence ORDER BY id`.execute(this.db)).rows;
    return {...registry,transitions:ts.map(r=>({...common(r),fromPatchId:r.from_patch_id,changeLevel:r.change_level})),heroImpacts:hs.map(r=>({...common(r),heroId:r.hero_id,impactLevel:r.impact_level}))};
  }
}
export class PatchHistoryRepository{
  constructor(private readonly db:Db){}
  async readAsOf(input:PatchHistoryRequest){
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx=>resolveHistoryWeights(input,await new PatchMetaRepository(trx).snapshot()));
  }
}
