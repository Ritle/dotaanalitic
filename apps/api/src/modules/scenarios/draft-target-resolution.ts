import {z} from 'zod';
import {CatalogIdSchema,Steam32Schema} from '@dota/contracts';
import {registryHash,registrySha} from '@dota/db';
import {CaptureTimeSchema,DraftCaptureSavedSchema} from './draft-capture-contract.js';

const Id=CatalogIdSchema,Us=z.string().regex(/^-?\d{1,20}$/),Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Ordinal=z.object({id:Id,value:z.unknown(),valueSha256:Hash,reviewState:z.enum(['accepted','unverified','rejected','conflict']),
  evidenceRef:z.string().nullable(),fetchedAtUs:Us,recordedAtUs:Us}).strict();
const Player=z.object({slot:z.number().int(),accountId:Steam32Schema.nullable(),heroId:z.number().int().nullable()}).strict();
export const DraftTargetCandidateSchema=z.object({matchId:Id,dataRevision:z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(v=>BigInt(v)<=9223372036854775807n),isPro:z.boolean().nullable(),ingestState:z.string(),
  startedAtUs:Us,radiantTeamId:Id.nullable(),direTeamId:Id.nullable(),mapNumber:z.number().int().nullable(),
  series:z.object({provider:z.string().nullable(),providerSeriesId:z.string().nullable()}).strict().nullable(),
  players:z.array(Player).max(100),ordinals:z.array(Ordinal).max(100),
  outcome:z.object({verified:z.boolean(),receiptId:Id.nullable()}).strict(),
  receipt:z.object({id:Id,provider:z.string(),providerMatchId:z.string(),payloadSha256:Hash,
    fetchedAtUs:Us,projection:z.record(z.string(),z.unknown())}).strict().nullable()
}).strict();
export const DraftTargetAuditInputSchema=z.object({format:z.literal('draft-target-audit-input-v1'),
  inspectedAt:CaptureTimeSchema,syntheticOnly:z.boolean(),
  items:z.array(z.object({capture:DraftCaptureSavedSchema,candidates:z.array(DraftTargetCandidateSchema).max(200)}).strict()).max(100)
}).strict();
type Candidate=z.infer<typeof DraftTargetCandidateSchema>;
const ExternalId=z.union([z.number().int().positive().safe(),z.string().regex(/^[1-9]\d{0,18}$/)]).transform(String);
const ReceiptProjection=z.object({match_id:ExternalId,series_id:ExternalId.nullish(),start_time:z.number().int().nonnegative().safe(),
  players:z.array(z.object({player_slot:z.number().int(),account_id:ExternalId.nullish(),hero_id:z.number().int().positive()})).length(10)});
export function captureMicros(at:string){CaptureTimeSchema.parse(at);return BigInt(Date.parse(at.slice(0,19)+'Z'))*1000n+BigInt(at.slice(20,26));}
function validPlayers(players:Candidate['players']){
  return players.length===10&&new Set(players.map(p=>p.slot)).size===10&&players.every(p=>[0,1,2,3,4,128,129,130,131,132].includes(p.slot))
    &&players.every(p=>p.accountId!==null&&p.heroId!==null&&p.heroId>0)
    &&new Set(players.map(p=>p.accountId)).size===10&&new Set(players.map(p=>p.heroId)).size===10;
}
/** Retrospective target audit only: never a feature builder or release gate. */
export function resolveDraftTargets(raw:unknown){
  const source=DraftTargetAuditInputSchema.parse(raw),reviewed=captureMicros(source.inspectedAt);
  if(new Set(source.items.map(i=>i.capture.id)).size!==source.items.length)throw Error('duplicate_capture');
  const items=source.items.map(({capture,candidates})=>{
    if(registrySha(JSON.stringify(capture.snapshot))!==capture.sha256)throw Error('capture_hash_mismatch');
    if(new Set(candidates.map(c=>c.matchId)).size!==candidates.length)throw Error('duplicate_candidate_map');
    const c=capture.snapshot,target=c.target,recorded=captureMicros(capture.recordedAt),cutoff=captureMicros(c.decisionCutoffAt);
    const captureReasons:string[]=[];
    if(!target)captureReasons.push('TARGET_REFERENCE_MISSING');
    if(recorded>reviewed||recorded<cutoff||captureMicros(c.scenarioRecordedAt)>cutoff)captureReasons.push('CAPTURE_CLOCK_INCONSISTENT');
    if(c.players.some(p=>p.accountId===null||p.heroId===null||p.identityStatus!=='verified')||new Set(c.players.map(p=>p.accountId)).size!==10
      ||new Set(c.players.map(p=>p.heroId)).size!==10)captureReasons.push('CAPTURE_PLAYERS_UNRESOLVED');
    const ledger=candidates.map(m=>{
      const reasons=[...captureReasons],r=m.receipt;
      if(!m.isPro||m.ingestState==='conflict'||!m.outcome.verified||!r||m.outcome.receiptId!==r.id)reasons.push('PRO_MAP_SOURCE_UNVERIFIED');
      if(!target||target.provider!=='opendota'||m.series?.provider!=='opendota')reasons.push('PROVIDER_SERIES_MAPPING_UNVERIFIED');
      else if(m.series.providerSeriesId!==target.providerSeriesId)reasons.push('SERIES_MISMATCH');
      const teamASide=m.radiantTeamId===c.scenario.teamAId&&m.direTeamId===c.scenario.teamBId?'radiant':
        m.direTeamId===c.scenario.teamAId&&m.radiantTeamId===c.scenario.teamBId?'dire':null;
      if(!teamASide)reasons.push('TEAM_SIDES_MISMATCH');
      const facts=m.ordinals.filter(o=>BigInt(o.fetchedAtUs)<=reviewed&&BigInt(o.recordedAtUs)<=reviewed);
      const accepted=facts.filter(o=>o.reviewState==='accepted');
      if(facts.some(o=>o.reviewState==='conflict')||new Set(accepted.map(o=>JSON.stringify(o.value))).size>1)reasons.push('MAP_NUMBER_CONFLICT');
      if(!accepted.length||accepted.some(o=>!o.evidenceRef||registryHash(o.value)!==o.valueSha256||BigInt(o.recordedAtUs)<BigInt(o.fetchedAtUs)
        ||!Number.isInteger(o.value)||typeof o.value!=='number'||o.value<1||o.value>5))reasons.push('MAP_NUMBER_EVIDENCE_MISSING');
      if(!target||m.mapNumber!==target.mapNumber||accepted.some(o=>o.value!==target.mapNumber))reasons.push('MAP_NUMBER_MISMATCH');
      const parsed=r?ReceiptProjection.safeParse(r.projection):null;
      if(!r||r.provider!=='opendota'||r.providerMatchId!==m.matchId||BigInt(r.fetchedAtUs)>reviewed||!parsed?.success)reasons.push('RECEIPT_UNVERIFIED');
      else{
        const p=parsed.data;
        if(p.match_id!==m.matchId||p.series_id!==m.series?.providerSeriesId||BigInt(p.start_time)*1000000n!==BigInt(m.startedAtUs))reasons.push('RECEIPT_CONTEXT_MISMATCH');
        if(!validPlayers(m.players)||p.players.some(p=>!m.players.some(x=>x.slot===p.player_slot&&x.accountId===p.account_id&&x.heroId===p.hero_id))
          ||new Set(p.players.map(p=>p.player_slot)).size!==10)reasons.push('ACTUAL_PLAYERS_SOURCE_MISMATCH');
      }
      if(!validPlayers(m.players))reasons.push('ACTUAL_PLAYERS_INCOMPLETE');
      if(teamASide&&c.players.some(p=>!m.players.some(a=>a.accountId===p.accountId&&a.heroId===p.heroId
        &&(a.slot<128? 'radiant':'dire')===(p.teamSlot==='A'?teamASide:teamASide==='radiant'?'dire':'radiant'))))reasons.push('DRAFT_PARTICIPANTS_MISMATCH');
      const beforeProviderStart=recorded<BigInt(m.startedAtUs)&&cutoff<BigInt(m.startedAtUs);
      return {matchId:m.matchId,dataRevision:m.dataRevision,matched:reasons.length===0,teamASide,beforeProviderStart,
        providerStartedAtUs:m.startedAtUs,receiptId:r?.id??null,receiptPayloadSha256:r?.payloadSha256??null,
        ordinalObservationIds:accepted.map(o=>o.id),reasons:[...new Set(reasons)].sort()};
    }).sort((a,b)=>BigInt(a.matchId)<BigInt(b.matchId)?-1:1);
    const matches=ledger.filter(r=>r.matched),unique=matches.length===1?matches[0]!:null;
    return {captureId:capture.id,captureSha256:capture.sha256,scenarioId:c.scenarioId,revision:c.revision,
      bindingStatus:unique?'matched':'unavailable',actualMatchId:unique?.matchId??null,teamASide:unique?.teamASide??null,
      temporalStatus:unique?(unique.beforeProviderStart?'before_provider_start_semantics_unverified':'not_before_provider_start'):'unavailable',
      reasons:unique?['ACTUAL_GAMEPLAY_START_SEMANTICS_UNVERIFIED',...(!unique.beforeProviderStart?['CAPTURE_NOT_BEFORE_PROVIDER_START']:[])]:
        [...captureReasons,matches.length>1?'AMBIGUOUS_MAP':candidates.length?'NO_VERIFIED_MATCHING_MAP':'NO_LOCAL_CANDIDATES'],ledger,
      prestartVerified:false,primaryEligible:false,deployable:false};
  });
  return {format:'draft-target-audit-result-v1',inspectedAt:source.inspectedAt,syntheticOnly:source.syntheticOnly,
    items,matched:items.filter(i=>i.bindingStatus==='matched').length,prestartVerified:0,scoringPerformed:false,deployable:false};
}
