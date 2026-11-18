import {test,expect} from 'vitest';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {draftTargetFixture} from '../../../tests/helpers/draft-target.js';
import {saveDraftTargetAudit,verifyDraftTargetAudit} from '../../../tools/audits/draft-target-resolution.mjs';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');

test('separate frozen audit replays exactly, refuses overwrite, external-SHA, code and result tampering',async()=>{
  const path=fileURLToPath(new URL(`../../../.tools/synthetic-target-${randomUUID()}.json`,import.meta.url));
  try{
    const saved=await saveDraftTargetAudit(draftTargetFixture(),path);
    expect((await verifyDraftTargetAudit(path,saved.sha256)).result).toMatchObject({syntheticOnly:true,matched:1,prestartVerified:0,deployable:false});
    await expect(saveDraftTargetAudit(draftTargetFixture(),path)).rejects.toMatchObject({code:'EEXIST'});
    await expect(verifyDraftTargetAudit(path,'0'.repeat(64))).rejects.toThrow();
    const original=await readFile(path,'utf8');
    for(const change of ['result','code','source','extra']){
      const data=JSON.parse(original);
      if(change==='result')data.result.prestartVerified=1;
      if(change==='code')data.code['apps/api/src/modules/scenarios/draft-target-resolution.ts']='0'.repeat(64);
      if(change==='source')data.source.items[0].capture.snapshot.players[0].heroId=99;
      if(change==='extra')data.deployable=true;
      const bytes=JSON.stringify(data);await writeFile(path,bytes);
      await expect(verifyDraftTargetAudit(path,sha(bytes))).rejects.toThrow();
    }
  }finally{await unlink(path).catch(()=>{});}
});
