import { expect, it } from 'vitest';
import { ReadinessRequestSchema, type ReadinessRequest } from '@dota/contracts';
import { assessContextReadiness, selectReadyMapIds } from '../src/readiness.js';
import { request, observations, retrospective, registry, knownPlayers, start, end, snapshotAt } from './readiness-fixtures.js';

function assess(rows = observations(), query: ReadinessRequest = request, patches = registry(), players = knownPlayers, completedAt: string | null = end) {
  return assessContextReadiness(rows, patches, players, start, completedAt, query);
}
const conditional: ReadinessRequest = { ...request, cohort: 'conditional_lineup_reconstructed', assumedFacts: ['lineup','teams'] };
it('dated evidence fetched later supports strict context without using fetch as known time', () => {
  const result = assess();
  expect(result).toMatchObject({ status: 'ready', evidenceBasis: 'verified_historical', appliedAssumptions: [],
    trainingEligibility: 'not_assessed', predictionEligibility: 'not_assessed' });
  expect(result.fields.find(row => row.field === 'lineup')?.evidence[0]).toMatchObject({ knownAt: start, fetchedAt: snapshotAt, eligible: true });
});
it('a completed-map lineup fetched in 2026 is never a verified 2024 pre-match lineup', () => {
  const result = assess(retrospective());
  expect(result.status).toBe('incomplete'); expect(result.missingFacts).toEqual(['lineup','teams']);
  expect(result.fields.find(row => row.field === 'lineup')?.fact).toBeNull();
  const allowed = assess(retrospective(), conditional);
  expect(allowed).toMatchObject({ status: 'ready', evidenceBasis: 'retrospective_conditional', appliedAssumptions: ['lineup','teams'] });
  expect(allowed.fields.find(row => row.field === 'lineup')?.evidence[0]?.knownAt).toBeNull();
});
it('each reconstructed fact must be explicitly assumed and unknown evidence stays unknown', () => {
  expect(assess(retrospective(), { ...conditional, assumedFacts: ['lineup'] }).missingFacts).toContain('teams');
  const rows = retrospective().map(row => ({ ...row, availability: 'unknown' as const }));
  expect(assess(rows, conditional).missingFacts).toContain('lineup');
});
it('post-draft heroes need their own assumption; pre-match never exposes hero values', () => {
  const post = { ...conditional, stage: 'post_draft' as const, requiredFacts: ['lineup','heroes'] as const };
  expect(assess(retrospective(), { ...post, requiredFacts: [...post.requiredFacts] }).missingFacts).toContain('heroes');
  expect(assess(retrospective(), { ...post, requiredFacts: [...post.requiredFacts], assumedFacts: ['lineup','heroes'] }).status).toBe('ready');
  expect(assess().fields.find(row => row.field === 'heroes')).toMatchObject({ status: 'not_applicable', fact: null, evidence: [] });
  expect(() => ReadinessRequestSchema.parse({ ...request, requiredFacts: ['heroes'] })).toThrow();
});
it('owner assertions are distinct and must have been recorded before cutoff', () => {
  const rows = observations().map(row => ({ ...row, provider: 'owner', availability: 'user_asserted_asof' as const, fetchedAt: start, recordedAt: start }));
  const owner = { ...request, cohort: 'owner_asserted_asof' as const };
  expect(assess(rows).status).toBe('incomplete'); expect(assess(rows, owner).status).toBe('ready');
  expect(assess(rows.map(row => ({ ...row, fetchedAt: snapshotAt })), owner).missingFacts).toContain('lineup');
  expect(assess(rows.map(row => ({ ...row, provider: 'opendota' })), owner).missingFacts).toContain('lineup');
  expect(assess(rows, conditional).missingFacts).toContain('lineup');
  expect(assess(rows.map(row=>({...row,recordedAt:null})),owner).missingFacts).toContain('lineup');
  expect(assess(rows.map(row=>({...row,recordedAt:snapshotAt})),owner).missingFacts).toContain('lineup');
});
it.each(['knownAt','eventAt'] as const)('late %s cannot enter strict cohort', clock => {
  const rows = observations().map(row => ({ ...row, [clock]: end }));
  expect(assess(rows).missingFacts).toContain('lineup');
});
it('future fetched data, unreviewed facts and missing evidence refs cannot enter any cohort', () => {
  for (const change of [{ fetchedAt: '2027-01-01T00:00:00.000Z' }, { reviewState: 'unverified' as const }, { evidenceRef: null }]) {
    expect(assess(retrospective().map(row => ({ ...row, ...change })), conditional).status).toBe('incomplete');
  }
});
it('conflicts fail closed; source order and an excluded retrospective correction do not change strict facts', () => {
  const rows = observations(); const original = assess(rows);
  expect(assess([...rows].reverse())).toEqual(original);
  const conflicting = { ...rows[1]!, id: '99', fact: { field: 'teams' as const, value: { radiantTeamId: '22', direTeamId: '11' } } };
  expect(assess([...rows,conflicting]).fields.find(row => row.field === 'teams')?.reasons).toContain('CONFLICT');
  expect(assess([...rows,{ ...conflicting, availability: 'retrospective_fact', knownAt: null }]).status).toBe('ready');
  expect(assess([...rows,{ ...conflicting, availability: 'retrospective_fact', knownAt: null }],conditional).status).toBe('incomplete');
});
it('partial/unknown identities and partial heroes do not count as full context', () => {
  expect(assess(observations(), request, registry(), knownPlayers.slice(1)).missingFacts).toContain('lineup');
  const rows = observations(); const heroes = rows.find(row=>row.fact.field==='heroes')!;
  if (heroes.fact.field === 'heroes') heroes.fact.value = heroes.fact.value!.slice(1);
  expect(assess(rows, { ...request, stage: 'post_draft', requiredFacts: ['heroes'] }).missingFacts).toContain('heroes');
});
it('estimated, low-confidence and conflicting role positions stay unavailable', () => {
  for (const change of [{ basis: 'estimated' as const }, { confidence: 0.9 }, { rolePos: 1 }]) {
    const rows = observations(); const roles = rows.find(row=>row.fact.field==='roles')!;
    if (roles.fact.field === 'roles') roles.fact.value![1] = { ...roles.fact.value![1]!, ...change };
    expect(assess(rows,{ ...request, requiredFacts: ['roles'] }).missingFacts).toContain('roles');
  }
});
it('late patch metadata is retrospective only under an explicit assumption, never a verified cutoff fact', () => {
  const r = registry(); r.patches[0]!.knownAt = '2025-01-01T00:00:00.000Z';
  expect(assess(observations(),request,r).missingFacts).toContain('patch');
  expect(assess(retrospective(),conditional,r).missingFacts).toContain('patch');
  const result = assess(retrospective(),{ ...conditional, assumedFacts: ['lineup','teams','patch'] },r);
  expect(result.status).toBe('ready'); expect(result.appliedAssumptions).toContain('patch');
  expect(result.fields.find(row=>row.field==='patch')?.availability).toBe('retrospective_fact');
});
it('conditional research requires a completed map at snapshot, and cannot reconstruct first-pick/order', () => {
  expect(assess(retrospective(),conditional,registry(),knownPlayers,null).blockers).toContain('MAP_NOT_COMPLETED_AT_SNAPSHOT');
  expect(assess(retrospective(),{ ...conditional,snapshotAt:start }).status).toBe('incomplete');
  expect(() => ReadinessRequestSchema.parse({ ...conditional,stage:'post_draft',assumedFacts:['lineup','draft_order_version'] })).toThrow();
});
it('selection deduplicates maps but refuses different cohorts or conflicting snapshots', () => {
  const strict = assess(), reconstructed = assess(retrospective(),conditional);
  expect(selectReadyMapIds([strict,strict],strict.policyKey)).toEqual([request.matchId]);
  expect(() => selectReadyMapIds([strict,reconstructed],strict.policyKey)).toThrow(/policy_mismatch/);
  const incomplete = assess([]);
  expect(() => selectReadyMapIds([strict,incomplete],strict.policyKey)).toThrow(/snapshot_conflict/);
  expect(() => selectReadyMapIds([incomplete,strict],strict.policyKey)).toThrow(/snapshot_conflict/);
});
