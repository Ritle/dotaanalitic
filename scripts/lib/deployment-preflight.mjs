import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {domainToASCII,fileURLToPath} from 'node:url';
import {parseEnv,parseArgs} from 'node:util';
const placeholder=value=>!value?.trim()||/replace-this|change-me|placeholder/i.test(value);
const safeToken=value=>!value?.trim()||/^[!-~]{1,4096}$/.test(value.trim());
export function productionEnvironmentChecks(values,ambient){
  const checks=[],add=(name,ok,detail,mandatory=true)=>checks.push({name,ok:!!ok,detail,mandatory});
  for(const key of ['DATABASE_URL','POSTGRES_DB','POSTGRES_USER','POSTGRES_PASSWORD'])
    add('Env:'+key,!placeholder(values[key]),'Значение задано без шаблонной подстановки.');
  const host=domainToASCII(values.SITE_HOST??'').toLowerCase();
  const domain=/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  add('Env:SITE_HOST',!placeholder(values.SITE_HOST)&&domain.test(host)&&
    !/(?:^|\.)(?:example\.(?:com|org|net)|invalid|test|localhost|example)$/.test(host),'Нужен собственный домен без схемы, порта и примера example; DNS/TLS здесь не проверяются.');
  let originOk=false,databaseOk=false;
  try{const u=new URL(values.WEB_ORIGIN);originOk=u.protocol==='https:'&&u.hostname===host&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash&&!u.port;}catch{/* safe field-only result */}
  add('Auth HTTPS origin',originOk,'WEB_ORIGIN должен быть HTTPS origin того же SITE_HOST.');
  add('Auth cookie secret',(values.AUTH_COOKIE_SECRET?.length??0)>=32&&!placeholder(values.AUTH_COOKIE_SECRET),'Нужен постоянный случайный ключ не короче32 символов; значение не выводится.');
  try{const u=new URL(values.DATABASE_URL);databaseOk=['postgres:','postgresql:'].includes(u.protocol)&&u.hostname==='postgres'&&
    (!u.port||u.port==='5432')&&!u.search&&!u.hash&&decodeURIComponent(u.username)===values.POSTGRES_USER&&
    decodeURIComponent(u.password)===values.POSTGRES_PASSWORD&&decodeURIComponent(u.pathname.slice(1))===values.POSTGRES_DB;}catch{/* no connection string in diagnostics */}
  add('Compose database URL',databaseOk,'DATABASE_URL должен согласовываться с POSTGRES_* и сервисом postgres:5432, без query overrides.');
  add('Production mode',!values.NODE_ENV||values.NODE_ENV==='production','NODE_ENV в выбранном файле должен быть production, если задан.');
  add('PandaScore token syntax',safeToken(values.PANDASCORE_API_TOKEN),'Настроенный токен должен быть допустимым server-side header.');
  add('Role profiles mode',values.ROLE_PROFILES_ENABLED===undefined||['true','false'].includes(values.ROLE_PROFILES_ENABLED),'ROLE_PROFILES_ENABLED допускает только true или false; default false.');
  add('STRATZ token syntax',safeToken(values.STRATZ_API_TOKEN?.trim().replace(/^Bearer\s+/i,'')),'Ключ STRATZ должен быть допустимым server-side header.');
  add('PandaScore configured',!!values.PANDASCORE_API_TOKEN?.trim(),'Без токена новое расписание недоступно; сохранённые данные продолжают читаться.',false);
  add('OpenDota key syntax',safeToken(values.OPENDOTA_API_KEY),'Настроенный ключ должен быть допустимым server-side header.');
  for(const [key,fallback,max] of [['OPENDOTA_RPM_BUDGET',45,45],['OPENDOTA_DAILY_BUDGET',2000,3000],['OPENDOTA_MONTHLY_BUDGET',45000,45000]]){
    const n=Number(values[key]||fallback);add('Budget:'+key,Number.isInteger(n)&&n>=1&&n<=max,'Бюджет должен соответствовать допустимому диапазону текущего worker.');
  }
  const keys=['DATABASE_URL','POSTGRES_DB','POSTGRES_USER','POSTGRES_PASSWORD','SITE_HOST','WEB_ORIGIN','AUTH_COOKIE_SECRET',
    'PANDASCORE_API_TOKEN','ROLE_PROFILES_ENABLED','STRATZ_API_TOKEN','OPENDOTA_API_KEY','OPENDOTA_RPM_BUDGET','OPENDOTA_DAILY_BUDGET','OPENDOTA_MONTHLY_BUDGET'];
  const conflicts=keys.filter(key=>values[key]!==undefined&&ambient[key]!==undefined&&ambient[key]!==values[key]);
  add('Environment overrides',conflicts.length===0,conflicts.length?'Переменные процесса отличаются от выбранного файла: '+conflicts.join(', '):'Выбранный файл не перекрыт другим окружением.');
  return checks;
}
/** Inspect rendered JSON in memory; never print Docker output containing secrets. */
export function productionComposeChecks(config,values){
  const checks=[],add=(name,ok,detail)=>checks.push({name,ok:!!ok,detail,mandatory:true}),s=config?.services??{};
  const env=name=>s[name]?.environment??{};
  add('Compose services',['postgres','migrate','api','worker','web'].every(name=>s[name]),'Нужны postgres, migrate, api, worker и web.');
  add('Private service ports',['postgres','migrate','api','worker'].every(name=>s[name]&&!(s[name].ports?.length)),'БД, API и worker не должны публиковать host ports.');
  const ports=s.web?.ports??[];
  add('Web ports',ports.length===3&&['80:80:tcp','443:443:tcp','443:443:udp'].every(key=>ports.some(p=>`${p.published}:${p.target}:${p.protocol??'tcp'}`===key)),
    'Публичные порты текущего профиля:80/tcp,443/tcp,443/udp.');
  add('Compose database credentials',['POSTGRES_DB','POSTGRES_USER','POSTGRES_PASSWORD'].every(k=>env('postgres')[k]===values[k])&&
    ['migrate','api','worker'].every(name=>env(name).DATABASE_URL===values.DATABASE_URL),'Все сервисы должны использовать выбранную БД.');
  add('Compose API auth',env('api').NODE_ENV==='production'&&env('api').WEB_ORIGIN===values.WEB_ORIGIN&&env('api').AUTH_COOKIE_SECRET===values.AUTH_COOKIE_SECRET,
    'API должен получить production mode, origin и постоянный cookie secret.');
  add('Compose schedule provider',(env('api').PANDASCORE_API_TOKEN??'')===(values.PANDASCORE_API_TOKEN??''),'API должен получить выбранный PandaScore token, если настроен.');
  add('Compose role providers',(env('api').ROLE_PROFILES_ENABLED??'false')===(values.ROLE_PROFILES_ENABLED??'false')&&
    (env('api').STRATZ_API_TOKEN??'')===(values.STRATZ_API_TOKEN??''),'API должен получить выбранные настройки профилей ролей.');
  add('Compose worker provider',env('worker').OPENDOTA_BASE_URL==='https://api.opendota.com/api'&&
    (env('worker').OPENDOTA_API_KEY??'')===(values.OPENDOTA_API_KEY??'')&&
    [['OPENDOTA_RPM_BUDGET',45],['OPENDOTA_DAILY_BUDGET',2000],['OPENDOTA_MONTHLY_BUDGET',45000]].every(([k,d])=>Number(env('worker')[k]||d)===Number(values[k]||d)),
    'Worker должен получить разрешённый OpenDota endpoint, выбранный ключ и бюджеты.');
  add('Compose web host',env('web').SITE_HOST===values.SITE_HOST,'Caddy должен получить выбранный SITE_HOST.');
  return checks;
}
export async function runPreflight(){
  const root=fileURLToPath(new URL('../../',import.meta.url));let json=false;
  try{
    const {values:args}=parseArgs({options:{strict:{type:'boolean'},production:{type:'boolean'},'require-db':{type:'boolean'},
      'env-file':{type:'string'},json:{type:'boolean'}}});
    json=!!args.json;const prod=!!args.production,results=[];
    const check=(name,ok,detail,mandatory=true)=>results.push({name,level:ok?'PASS':mandatory?'FAIL':'WARN',detail,mandatory});
    const [major,minor]=process.versions.node.split('.').map(Number);
    check('Node',major>22||major===22&&minor>=12,`v${process.versions.node}; требуется Node>=22.12.0.`);
    const pm=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).packageManager;
    check('Package manager',/^pnpm@\d+/.test(pm),'packageManager должен задавать pnpm.');
    check('Lockfile',fs.existsSync(path.join(root,'pnpm-lock.yaml')),'Нужен registry-generated pnpm-lock.yaml.',prod||!!args.strict);
    const envPath=path.resolve(root,args['env-file']??(prod?'.env.production':'.env')),exists=fs.existsSync(envPath);
    let parsed={},parseOk=true;if(exists){try{parsed=parseEnv(fs.readFileSync(envPath,'utf8'));}catch{parseOk=false;}}
    const selected=exists?parsed:prod?{}:process.env;
    check('Environment',exists&&parseOk,exists?'Выбранный локальный private env-файл прочитан.':'Нужен выбранный env-файл; значения не выводятся.',prod||!!args['env-file']);
    if(prod)for(const c of productionEnvironmentChecks(selected,process.env))check(c.name,c.ok,c.detail,c.mandatory);
    else if(exists)check('Env:DATABASE_URL',!!selected.DATABASE_URL&&!/replace-this|change-me|localhost\.invalid/i.test(selected.DATABASE_URL),'DATABASE_URL задан без шаблонной подстановки.',!!args['require-db']);
    const envOk=(!prod||exists&&parseOk)&&!results.some(c=>c.level==='FAIL'&&c.name!=='Lockfile');
    const command=argv=>spawnSync('docker',argv,{cwd:root,env:process.env,encoding:'utf8',timeout:5000,windowsHide:true,maxBuffer:8*1024*1024});
    const compose=command(['compose','version']),available=compose.status===0;
    check('Docker Compose',available,available?'Compose CLI доступен.':'Compose CLI недоступен; native PostgreSQL поддерживается для development.',prod);
    if(prod){
      const engine=available?command(['info','--format','{{json .ServerVersion}}']):null;
      check('Docker Engine',engine?.status===0,'Нужен доступный Docker daemon; версия CLI не подтверждает engine.');
      if(available&&envOk){
        const rendered=command(['compose','--env-file',envPath,'-f',path.join(root,'compose.production.yaml'),'config','--format','json']);
        let config=null;if(rendered.status===0){try{config=JSON.parse(rendered.stdout);}catch{/* never echo Docker output */}}
        check('Compose rendering',config!==null,'Нужен успешный docker compose config --format json; результат с секретами не печатается.');
        if(config)for(const c of productionComposeChecks(config,selected))check(c.name,c.ok,c.detail,c.mandatory);
      }else check('Compose rendering',false,'Проверка отложена до корректного окружения и доступного Compose CLI.');
    }
    if(args['require-db']){
      if(!envOk||!selected.DATABASE_URL)check('Database connectivity',false,'Проверка БД отменена: сначала исправьте выбранное окружение.');
      else{
        let client;
        try{
          const {Client}=await import('pg');client=new Client({connectionString:selected.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:5000});
          await client.connect();await client.query('SELECT 1');check('Database connectivity',true,'Read-only probe выбранной БД выполнен.');
        }catch(e){
          const code=['ECONNREFUSED','ENOTFOUND','ETIMEDOUT','28P01','3D000'].includes(e?.code)?e.code:'CONNECTION_FAILED';
          check('Database connectivity',false,'Read-only probe не выполнен: '+code+'. Детали подключения не выводятся.');
        }finally{await client?.end().catch(()=>{});}
      }
    }
    const failures=results.filter(c=>c.level==='FAIL').length;
    const report={schemaVersion:1,scope:prod?'production_preflight_only':'development_preflight_only',status:failures?'blocked':'passed',checks:results,failures,
      environmentSource:args['env-file']?'explicit_file':exists?'default_file':prod?'missing_file':'process_environment',containerBuildExecuted:false,deploymentExecuted:false,modelActivationExecuted:false};
    if(json)console.log(JSON.stringify(report,null,2));
    else{for(const c of results)console.log(`${c.level.padEnd(4)} ${c.name}: ${c.detail}`);console.log(`Preflight: ${results.length} checks, ${failures} failures`);}
    if(failures)process.exitCode=1;
  }catch{
    const error={status:'blocked',code:'PREFLIGHT_FAILED',message:'Preflight не выполнен. Проверьте параметры и доступность локальных конфигурационных файлов; значения и исходные ошибки не выводятся.'};
    if(json)console.log(JSON.stringify(error));else console.error(error.message);process.exitCode=1;
  }
}
