import {readFile} from 'node:fs/promises';

const source=JSON.parse(await readFile(new URL('./bo3-edition-pages.json',import.meta.url),'utf8'));
const {scope,pageSize,pages}=source;

export function editionHttpComparison() {
  const pass=pages.map(({number,total,matches})=>({
    headers:{'x-page':String(number),'x-per-page':String(pageSize),'x-total':String(total)},
    body:matches
  }));
  return {format:'synthetic-edition-http-comparison-v1',scope:structuredClone(scope),pageSize,
    passes:[structuredClone(pass),structuredClone(pass)]};
}
