import {open} from 'node:fs/promises';
import {sha} from './evaluation-discovery-files.mjs';

// Matches the existing retest execution dataset reader. Discovery artifacts keep their smaller cap.
const MAX_DATASET_BYTES=134217728;
export async function saveRetestDataset(path,value){
 const bytes=JSON.stringify(value,null,2)+'\n',length=Buffer.byteLength(bytes,'utf8');
 if(length>MAX_DATASET_BYTES)throw Error('retest_import_dataset_file_limit');
 const file=await open(path,'wx');
 try{await file.writeFile(bytes,'utf8');}finally{await file.close();}
 return {sha256:sha(bytes),bytes:length};
}
