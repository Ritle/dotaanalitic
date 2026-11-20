import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {CatalogIdSchema} from '../../packages/contracts/dist/catalog.js';

const {z}=createRequire(new URL('../../packages/contracts/package.json',import.meta.url))('zod');
const count=z.number().int().nonnegative().safe();
const positive=count.positive();
export const pageFormat='synthetic-edition-pages-v1';
export const comparisonFormat='synthetic-edition-http-comparison-v1';
const scopeSchema=z.object({
  leagueId:CatalogIdSchema,editionId:CatalogIdSchema,stageIds:z.array(CatalogIdSchema).nonempty()
}).strict();
const matchesSchema=z.array(z.object({
  id:CatalogIdSchema,league_id:CatalogIdSchema,serie_id:CatalogIdSchema,tournament_id:CatalogIdSchema,
  number_of_games:positive.nullable(),status:z.enum(['played','cancelled','unknown'])
}).strict());
const bundleSchema=z.object({
  format:z.literal(pageFormat),scope:scopeSchema,
  pageSize:positive,
  pages:z.array(z.object({
    number:positive,total:count,snapshot:z.string().min(1),matches:matchesSchema
  }).strict())
}).strict();

const decimalHeader=z.string().regex(/^(0|[1-9]\d*)$/).transform(Number).pipe(count);
const httpPageSchema=z.object({
  headers:z.object({
    'x-page':decimalHeader.pipe(positive),
    'x-per-page':decimalHeader.pipe(positive.max(100)),
    'x-total':decimalHeader
  }).strict(),
  body:matchesSchema
}).strict();
const comparisonSchema=z.object({
  format:z.literal(comparisonFormat),scope:scopeSchema,pageSize:positive.max(100),
  passes:z.tuple([z.array(httpPageSchema),z.array(httpPageSchema)])
}).strict();

// Synthetic numbered pages of a single snapshot. total includes all formats and statuses.
export function assembleEditionPages(source) {
  return assemblePageInventory(bundleSchema.parse(source));
}

function assemblePageInventory({scope,pageSize,pages}) {
  const stages=new Set(scope.stageIds);
  assert.equal(stages.size,scope.stageIds.length,'duplicate reviewed stage');
  pages.sort((a,b)=>a.number-b.number);
  const issues=[], matches=[], seen=new Set();
  const first=pages[0];
  const last=first ? Math.max(1,Math.ceil(first.total/pageSize)) : 1;
  let next=1;
  for(const page of pages) {
    const number=page.number;
    if(number<next) {
      issues.push({code:'DUPLICATE_PAGE',page:number});
      continue;
    }
    if(number>last) {
      issues.push({code:'UNEXPECTED_PAGE',page:number});
      continue;
    }
    if(number>next) issues.push({code:'MISSING_PAGES',from:next,to:number-1});
    next=number+1;
    if(page.total!==first.total || page.snapshot!==first.snapshot) {
      issues.push({code:'CHANGED_SOURCE',page:number});
      continue;
    }
    const expected=number===last ? first.total-(number-1)*pageSize : pageSize;
    if(page.matches.length!==expected) issues.push({code:'PAGE_LENGTH',page:number,expected,received:page.matches.length});
    for(const row of page.matches) {
      const duplicate=seen.has(row.id);
      if(duplicate) issues.push({code:'DUPLICATE_MATCH',page:number,matchId:row.id});
      seen.add(row.id);
      if(row.league_id!==scope.leagueId || row.serie_id!==scope.editionId || !stages.has(row.tournament_id)) {
        issues.push({code:'OUTSIDE_SCOPE',page:number,matchId:row.id,leagueId:row.league_id,
          editionId:row.serie_id,stageId:row.tournament_id});
        continue;
      }
      if(!duplicate) matches.push({matchId:row.id,stageId:row.tournament_id,bestOf:row.number_of_games,status:row.status});
    }
  }
  if(next<=last) issues.push({code:'MISSING_PAGES',from:next,to:last});
  return {issues,inventory:{format:'synthetic-edition-inventory-v1',leagueId:scope.leagueId,
    editionId:scope.editionId,complete:issues.length===0,matches}};
}

export function compareEditionHttpPasses(source) {
  const {scope,pageSize,passes}=comparisonSchema.parse(source);
  const [first,second]=passes.map(responses=>{
    const pages=responses.map(({headers,body})=>({
      number:headers['x-page'],total:headers['x-total'],matches:body
    }));
    const {inventory,issues}=assemblePageInventory({scope,pageSize,pages});
    for(const {headers} of responses) {
      if(headers['x-per-page']!==pageSize) {
        issues.push({code:'PAGE_SIZE_HEADER',page:headers['x-page'],expected:pageSize,received:headers['x-per-page']});
      }
    }
    return {inventory,issues,total:pages[0]?.total ?? null};
  });
  const firstById=new Map(first.inventory.matches.map(row=>[row.matchId,row]));
  const secondById=new Map(second.inventory.matches.map(row=>[row.matchId,row]));
  const firstOnly=[],secondOnly=[],changedMatches=[];
  for(const [id,row] of firstById) {
    const other=secondById.get(id);
    if(!other) firstOnly.push(id);
    else if(row.stageId!==other.stageId || row.bestOf!==other.bestOf || row.status!==other.status) {
      changedMatches.push(id);
    }
  }
  for(const id of secondById.keys()) {
    if(!firstById.has(id)) secondOnly.push(id);
  }
  const complete=[first,second].every(pass=>pass.issues.length===0) && first.total===second.total &&
    firstOnly.length===0 && secondOnly.length===0 && changedMatches.length===0;
  return {inventory:{...first.inventory,complete},comparison:{
    passes:[first,second].map(({total,issues})=>({total,issues})),firstOnly,secondOnly,changedMatches
  }};
}
