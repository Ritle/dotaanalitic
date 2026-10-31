import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { auditCorpusCaptures } from '../packages/db/dist/index.js';
import { CorpusAuditConfigSchema } from '../packages/contracts/dist/index.js';
const [input,output,...rest]=process.argv.slice(2);
if(!input||!output||rest.length) {console.error('Использование: analyze-corpus.mjs config.json new-report.json');process.exit(2);}
try {
  if((await stat(input)).size>65536) throw new Error('config_limit');
  const config=CorpusAuditConfigSchema.parse(JSON.parse(await readFile(input,'utf8'))),captures=[];
  let total=0;
  for(const ref of config.captures) {
    const path=resolve(dirname(resolve(input)),ref.path),size=(await stat(path)).size;
    total+=size;if(size>32*1024*1024||total>64*1024*1024) throw new Error('capture_limit');
    captures.push({kind:ref.kind,sha256:ref.sha256,content:await readFile(path,'utf8')});
  }
  const report=auditCorpusCaptures(captures,config.request);
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({status:report.status,fingerprint:report.fingerprint,uniqueMaps:report.uniqueMaps,
    detailedMaps:report.detailedMaps,conflictingMaps:report.conflictingMaps,bySplit:report.bySplit,
    strictHistoricalEligibility:report.strictHistoricalEligibility,trainingReady:false,deployable:false}));
  if(report.status!=='diagnostic_complete') process.exitCode=3;
} catch(error) {
  console.error(error?.code==='EEXIST'?'Файл отчёта уже существует. Укажите новое имя.':
    'Аудит корпуса не выполнен: проверьте config, SHA capture, схему источника и горизонт snapshot.');
  process.exitCode=1;
}
