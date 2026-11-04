import {createHash} from 'node:crypto';
import {V1ForecastJournalReportSchema,V1JournalInputSchema} from '../../packages/contracts/src/index.js';
import {buildV1Journal} from '../../packages/db/src/v1-journal';
import {journalView} from '../../packages/db/src/v1-journal-reader';
import {journalInput,journalObservation,journalUuid} from '../../packages/db/tests/v1-journal-fixtures';
/** Explicit synthetic report, only for display/projection tests; never persisted in production. */
export function journalSavedFixture(n=1){
  const input=V1JournalInputSchema.parse(journalInput(Array.from({length:n},(_,i)=>journalObservation(i+1,{title:'Синтетический пример журнала'}))));
  const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const report=V1ForecastJournalReportSchema.parse({format:'v1-journal-report-v1',ownerId:journalUuid(900),
    request:{requestId:journalUuid(800),filters:{}},revision:1,previousSha256:null,inputSha256:hash(input),capturedAt:input.capturedAt,
    summary:buildV1Journal(input,{})});
  return {revision:1,sha256:hash(report),report,input};
}
export const journalViewFixture=(n=1,offset=0)=>journalView(journalSavedFixture(n),offset);
