import {V1JournalObservationSchema,type V1JournalObservation} from '@dota/contracts';
export const journalUuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
/** Synthetic pure-function fixture, never a production prediction or verified receipt. */
export function journalObservation(n=1,patch:Partial<V1JournalObservation>={}) {
  const id=journalUuid(n),matchId='9007199254742999';
  return V1JournalObservationSchema.parse({id,requestId:id,snapshotSha256:'a'.repeat(64),purpose:'real_map',status:'done',
    modelId:journalUuid(100),eligibleModelAtIssuance:true,probability:0.7,createdAt:'2026-01-01T12:00:00.000001Z',
    issuedAt:'2026-01-01T12:00:00.000002Z',cutoffAt:'2026-01-01T12:00:00.000Z',scenarioId:journalUuid(200),scenarioRevision:1,
    title:'Synthetic journal fixture',teamAId:'11',teamBId:'22',scheduledAt:'2026-01-02T00:00:00.000Z',
    lineupA:['101','102','103','104','105'],lineupB:['106','107','108','109','110'],
    target:{provider:'opendota',providerSeriesId:'321',mapNumber:1,sourceUrl:'https://example.test/synthetic',rationale:'Synthetic explicit first-map target'},
    attemptReasons:[],latestOutcome:null,binding:{sourcePredictionId:id,revision:1,sha256:'b'.repeat(64),matchId},bindingConflict:false,
    sourceChangedSinceRefresh:null,verification:{policyVersion:'verified-first-map-forecast-v1',predictionId:id,matchId,
      checkedAt:'2026-01-03T00:00:00.000Z',status:'linked',prospectiveEligible:true,rosterStatus:'matched',reasons:[],teamASide:'radiant',mapNumberEvidence:[],
      outcome:{status:'verified',matchId,outcomeReceiptId:'1',teamAId:'11',teamBId:'22',teamAWon:true,startedAt:'2026-01-02T00:00:00.000Z',
        completedAt:'2026-01-02T01:00:00.000Z',seriesId:journalUuid(300),dataRevision:'1',labelVerifiedAt:'2026-01-03T00:00:00.000Z',
        sourceEvidence:{receiptId:'1',payloadSha256:'c'.repeat(64),adapterVersion:'synthetic',normalizerVersion:'synthetic',receiptFetchedAt:'2026-01-02T02:00:00.000Z'}}},...patch});
}
export const journalInput=(observations:V1JournalObservation[])=>({format:'v1-journal-input-v1',capturedAt:'2026-01-03T00:00:00.000000Z',code:{syntheticOnly:true},observations});
