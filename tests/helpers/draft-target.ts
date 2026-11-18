import {registryHash,registrySha} from '../../packages/db/src/index.js';
import {scenarioInput} from './scenario.js';
import {DraftCaptureSnapshotSchema} from '../../apps/api/src/modules/scenarios/draft-capture-contract.js';
import {emptyCaptureHistory} from '../../apps/api/src/modules/scenarios/draft-capture-source.js';
import {DraftTargetAuditInputSchema} from '../../apps/api/src/modules/scenarios/draft-target-resolution.js';
/** Synthetic source assertions, never production training/evaluation data. */
export function draftTargetFixture(){
  const s=scenarioInput();s.context.mapNumber=2;s.draft={assignments:(['A','B'] as const).flatMap((teamSlot,j)=>
    Array.from({length:5},(_,i)=>({teamSlot,rolePos:i+1,heroId:j*5+i+1}))),bans:[]};
  const players=[...s.lineupA,...s.lineupB].map((p,i)=>({teamSlot:i<5?'A':'B',rolePos:p.rolePos,playerId:p.playerId,
    heroId:i+1,accountId:String(i+1000),identityStatus:'verified',observationIds:['synthetic:'+i]}));
  const snapshot=DraftCaptureSnapshotSchema.parse({format:'owner-draft-capture-v1',scenarioId:'123e4567-e89b-42d3-a456-426614174000',
    revision:1,scheduleTargetRequestId:null,scenarioHash:registrySha(JSON.stringify(s)),scenarioRecordedAt:'2026-01-01T11:00:00.000000Z',
    scenario:s,decisionCutoffAt:'2026-01-01T11:59:59.999998Z',players,identityEvidence:[],
    target:{status:'pending',provider:'opendota',providerSeriesId:'9007199254740993',mapNumber:2,actualMatchId:null,evidence:{}},
    history:emptyCaptureHistory(),status:'unavailable',reasons:['LOCAL_HISTORY_UNAVAILABLE'],warnings:[],primaryEligible:false,scoringPerformed:false,deployable:false});
  const start=BigInt(Date.parse('2026-01-01T12:00:00.000Z'))*1000n;
  const actual=players.map((p,i)=>({slot:i<5?i:i+123,accountId:p.accountId,heroId:p.heroId}));
  return DraftTargetAuditInputSchema.parse({format:'draft-target-audit-input-v1',inspectedAt:'2026-01-02T00:00:00.000000Z',syntheticOnly:true,
    items:[{capture:{id:'123e4567-e89b-42d3-a456-426614174001',sha256:registrySha(JSON.stringify(snapshot)),recordedAt:'2026-01-01T11:59:59.999999Z',snapshot},
      candidates:[{matchId:'9007199254740995',dataRevision:'1',isPro:true,ingestState:'accepted',startedAtUs:start.toString(),
        radiantTeamId:s.teamAId,direTeamId:s.teamBId,mapNumber:2,series:{provider:'opendota',providerSeriesId:'9007199254740993'},players:actual,
        ordinals:[{id:'9007199254740996',value:2,valueSha256:registryHash(2),reviewState:'accepted',evidenceRef:'synthetic:map-2',
          fetchedAtUs:(start+1000000000n).toString(),recordedAtUs:(start+1000000001n).toString()}],
        outcome:{verified:true,receiptId:'9007199254740997'},receipt:{id:'9007199254740997',provider:'opendota',providerMatchId:'9007199254740995',
          payloadSha256:'a'.repeat(64),fetchedAtUs:(start+1000000000n).toString(),projection:{match_id:'9007199254740995',series_id:'9007199254740993',
            start_time:Number(start/1000000n),players:actual.map(p=>({account_id:p.accountId,hero_id:p.heroId,player_slot:p.slot}))}}}]}]});
}
