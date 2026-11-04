import {expect,it,vi} from 'vitest';
import {journalView,V1JournalService} from '../src/v1-journal-reader.js';
import {V1JournalRepository} from '../src/v1-journal-repository.js';
import {journalSavedFixture} from '../../../tests/helpers/journal-view.js';
import type {Db} from '../src/index.js';
it('pages frozen rows after primary selection, preserves full metrics and omits raw private input',()=>{
  const saved=journalSavedFixture(51),first=journalView(saved),last=journalView(saved,50);
  expect(first.rows).toHaveLength(50);expect(first.hasMore).toBe(true);expect(last.rows).toHaveLength(1);expect(last.hasMore).toBe(false);
  expect(first.summary.metrics.n).toBe(1);expect(last.summary).toEqual(first.summary);
  expect(new Set([...first.rows,...last.rows].map(r=>r.predictionId)).size).toBe(51);
  expect(first.rows[0]!.predictionId>last.rows[0]!.predictionId).toBe(true);
  expect(JSON.stringify(first)).not.toMatch(/ownerId|barrels|syntheticOnly|lineupA|sourceEvidence|sourcePredictionId/);
  expect(()=>journalView(saved,-1)).toThrow('journal_invalid_offset');expect(()=>journalView(saved,5001)).toThrow('journal_invalid_offset');
});
it('reports frozen orientation, roster mismatch and source correction without recomputing metrics',()=>{
  const saved=journalSavedFixture();saved.input.observations[0]!.verification!.rosterStatus='mismatched';
  saved.input.observations[0]!.sourceChangedSinceRefresh=true;
  expect(journalView(saved).rows[0]).toMatchObject({actualWinner:'A',rosterStatus:'mismatched',sourceChangedSinceRefresh:true,probability:0.7});
});
it('bounds admission before taking database connections and releases it after a failed creation',async()=>{
  let reject!:(e:Error)=>void;
  const spy=vi.spyOn(V1JournalRepository.prototype,'create').mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}));
  try{const service=await V1JournalService.open({} as Db),first=service.create('owner',{});const rejected=expect(first).rejects.toThrow('synthetic');
    await expect(service.create('owner',{})).rejects.toThrow('journal_request_busy');expect(spy).toHaveBeenCalledTimes(1);
    reject(Error('synthetic'));await rejected;spy.mockResolvedValueOnce(journalSavedFixture());expect((await service.create('owner',{})).summary.metrics.n).toBe(1);
  }finally{spy.mockRestore();}
});
