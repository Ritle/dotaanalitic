// Synthetic provider responses for isolated tests only. Never seed the working database.
export const scheduleToken='synthetic-pandascore-test-secret';
export function syntheticSchedule(){return [{id:70001,name:'Синтетическая встреча Alpha — Beta',status:'not_started',
  scheduled_at:new Date(Date.now()+86400000).toISOString(),tournament:{id:71001,name:'Синтетический финал'},
  league:{id:72001,name:'Синтетическая лига'},serie:{id:73001,name:'Тест'},videogame:{slug:'dota-2'},number_of_games:3,
  opponents:[{type:'Team',opponent:{id:74001,name:'Синтетическая Alpha'}},{type:'Team',opponent:{id:74002,name:'Синтетическая Beta'}}]}];}
export function syntheticRosters(){return {type:'Team',rosters:[74001,74002].map((id,i)=>({id,name:i?'Синтетическая Beta':'Синтетическая Alpha',
  players:Array.from({length:i?5:6},(_,j)=>({id:75001+i*10+j,name:`Синтетический игрок ${i+1}-${j+1}`,birthday:'not-retained'}))}))};}
