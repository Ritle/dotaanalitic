import { planFixture, registeredAt } from './research-plan-fixtures.js';
import { micros, seriesId } from './research-elo-fixtures.js';
import { planResearchElo } from '../src/research-plan.js';
import { freezeResearchElo } from '../src/research-elo.js';
import { researchExecutionRequest } from '../src/research-execution.js';

export function executionFixture() {
  const sources = planFixture();
  const plan = planResearchElo(sources.request, sources.prior, sources.discovery, registeredAt);
  const { fingerprint: _priorFingerprint, ...body } = structuredClone(sources.prior);
  body.request = researchExecutionRequest(plan);
  for (const m of body.candidates) if (m.outcome.status === 'verified') m.outcome.labelVerifiedAt = body.request.snapshotAt;
  const rows = [
    ...plan.warmup.assessments.map(m => ({ id: m.matchId, start: m.startedAt, series: Number(m.seriesKey!.split(':')[1]) })),
    { id: '201', start: '2026-11-02T12:00:00.000Z', series: 201 },
    { id: '202', start: '2026-11-03T12:00:00.000Z', series: 202 }
  ];
  for (const row of rows) {
    const m = structuredClone(body.candidates[0]!);
    const end = new Date(Date.parse(row.start) + 1800000).toISOString();
    m.matchId = row.id; m.startedAtUs = micros(row.start); m.endedAtUs = micros(end); m.seriesId = seriesId(row.series);
    m.syncedAtUs = micros('2026-11-04T00:00:00.000Z'); m.facts = [];
    if (m.outcome.status !== 'verified') throw Error('fixture_outcome');
    m.outcome = { ...m.outcome, matchId: row.id, outcomeReceiptId: row.id, startedAt: row.start, completedAt: end,
      seriesId: m.seriesId, sourceEvidence: { ...m.outcome.sourceEvidence, receiptId: row.id, receiptFetchedAt: '2026-11-04T00:00:00.000Z' } };
    body.candidates.push(m);
    if (!body.aliases.some(a => a.seriesId === m.seriesId)) body.aliases.push({ seriesId: m.seriesId,
      provider: 'opendota', providerSeriesId: String(row.series), teamAId: '11', teamBId: '22' });
  }
  return { sources, plan, snapshot: freezeResearchElo(body), now: plan.request.evaluationNotBefore, code: body.code };
}
