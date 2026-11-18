import {z} from 'zod';
import {registrySha} from '@dota/db';
import {CatalogIdSchema} from '@dota/contracts';
import {CaptureTimeSchema,DraftCaptureSavedSchema} from './draft-capture-contract.js';
import {DraftTargetCandidateSchema,captureMicros} from './draft-target-resolution.js';
import {DraftNativeResultSchema} from './draft-native-contract.js';
const Source=z.object({capture:DraftCaptureSavedSchema,matchId:CatalogIdSchema,inspectedAt:CaptureTimeSchema,
  candidate:DraftTargetCandidateSchema.nullable()}).strict();
const ExternalId=z.union([z.number().int().positive().safe(),z.string().regex(/^[1-9]\d{0,18}$/)]).transform(String);
const Projection=z.object({match_id:ExternalId,start_time:z.number().int().nonnegative().safe(),
  players:z.array(z.object({player_slot:z.number().int(),account_id:ExternalId,hero_id:z.number().int().positive()})).length(10)});
/** Native-map equality is separate from provider-series/ordinal and pre-start eligibility. */
export function verifyNativeDraft(raw:unknown){
  const {capture,matchId,inspectedAt,candidate:m}=Source.parse(raw),c=capture.snapshot,reasons:string[]=[];
  if(registrySha(JSON.stringify(c))!==capture.sha256)throw Error('capture_hash_mismatch');
  const reviewed=captureMicros(inspectedAt),cutoff=captureMicros(c.decisionCutoffAt),recorded=captureMicros(capture.recordedAt);
  if(recorded>reviewed||recorded<cutoff||captureMicros(c.scenarioRecordedAt)>cutoff)reasons.push('CAPTURE_CLOCK_INCONSISTENT');
  if(c.players.some(p=>p.accountId===null||p.heroId===null||p.identityStatus!=='verified')||new Set(c.players.map(p=>p.accountId)).size!==10||
    new Set(c.players.map(p=>p.heroId)).size!==10||c.players.filter(p=>p.teamSlot==='A').length!==5)reasons.push('CAPTURE_PLAYERS_UNRESOLVED');
  if(!m)reasons.push('LOCAL_MAP_MISSING');
  const side=m?.radiantTeamId===c.scenario.teamAId&&m.direTeamId===c.scenario.teamBId?'radiant':
    m?.direTeamId===c.scenario.teamAId&&m.radiantTeamId===c.scenario.teamBId?'dire':null;
  if(m){
    const r=m.receipt,p=Projection.safeParse(r?.projection);
    if(m.matchId!==matchId)reasons.push('MATCH_ID_MISMATCH');
    if(m.isPro!==true||m.ingestState==='conflict'||!m.outcome.verified||!r||m.outcome.receiptId!==r.id)reasons.push('PRO_MAP_SOURCE_UNVERIFIED');
    if(!side)reasons.push('TEAM_SIDES_MISMATCH');
    const slots=[0,1,2,3,4,128,129,130,131,132];
    const valid=m.players.length===10&&m.players.every(a=>slots.includes(a.slot)&&a.accountId!==null&&a.heroId!==null&&a.heroId>0)&&
      new Set(m.players.map(a=>a.slot)).size===10&&new Set(m.players.map(a=>a.accountId)).size===10&&new Set(m.players.map(a=>a.heroId)).size===10;
    if(!valid)reasons.push('ACTUAL_PLAYERS_INCOMPLETE');
    if(!r||r.provider!=='opendota'||r.providerMatchId!==matchId||BigInt(r.fetchedAtUs)>reviewed||!p.success)reasons.push('RECEIPT_UNVERIFIED');
    else{
      if(p.data.match_id!==matchId||BigInt(p.data.start_time)*1000000n!==BigInt(m.startedAtUs))reasons.push('RECEIPT_CONTEXT_MISMATCH');
      if(new Set(p.data.players.map(a=>a.player_slot)).size!==10||p.data.players.some(a=>!m.players.some(b=>b.slot===a.player_slot&&b.accountId===a.account_id&&b.heroId===a.hero_id)))reasons.push('ACTUAL_PLAYERS_SOURCE_MISMATCH');
    }
    if(side&&c.players.some(p=>!m.players.some(a=>a.accountId===p.accountId&&a.heroId===p.heroId&&
      (a.slot<128?'radiant':'dire')===(p.teamSlot==='A'?side:side==='radiant'?'dire':'radiant'))))reasons.push('DRAFT_PARTICIPANTS_MISMATCH');
  }
  const verified=reasons.length===0&&m!==null;
  return DraftNativeResultSchema.parse({format:'owner-draft-native-binding-v1',captureId:capture.id,captureSha256:capture.sha256,matchId,inspectedAt,
    status:verified?'verified':'unavailable',reasons:[...new Set(reasons)].sort(),teamASide:verified?side:null,
    dataRevision:m?.dataRevision??null,receiptId:m?.receipt?.id??null,receiptPayloadSha256:m?.receipt?.payloadSha256??null,providerStartedAtUs:m?.startedAtUs??null,
    temporalStatus:verified?(recorded<BigInt(m.startedAtUs)&&cutoff<BigInt(m.startedAtUs)?'before_provider_start_semantics_unverified':'not_before_provider_start'):'unavailable',
    selectionSource:'owner_native_map_id',scheduleMappingVerified:false,mapOrdinalVerified:false,prestartVerified:false,primaryEligible:false,deployable:false});
}
