import {parseArgs} from 'node:util';
import {runLocalRestoreDrill,safeDrillCode} from './lib/local-restore-drill.mjs';
try{
  const {values}=parseArgs({strict:true,allowPositionals:false,options:{'pg-bin':{type:'string'},bundle:{type:'string',multiple:true}}});
  if(!values['pg-bin'])throw Error('LOCAL_DATABASE_REQUIRED');
  console.log(JSON.stringify(await runLocalRestoreDrill({databaseUrl:process.env.DATABASE_URL,pgBin:values['pg-bin'],bundles:values.bundle??[]})));
}catch(error){
  console.error(JSON.stringify({status:'unavailable',code:safeDrillCode(error),message:'Проверка восстановления не завершена. Нужны локальный PostgreSQL 16, pg-bin, доступ CREATEDB и замороженные bundles зарегистрированных моделей. Рабочая база не является целью восстановления.'}));
  process.exitCode=1;
}
