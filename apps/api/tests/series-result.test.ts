import {test,expect} from 'vitest';
import {checkPandaSeriesResult} from '../src/modules/upcoming/series-result';
const expected={id:'1',teamA:'10',teamB:'20'},fetchedAt='2026-01-03T00:00:00Z';
const game=(position:number,winner:number)=>({id:100+position,position,match_id:1,status:'finished',finished:true,forfeit:false,
 begin_at:`2026-01-02T${9+position}:00:00Z`,end_at:`2026-01-02T${9+position}:45:00Z`,winner:{id:winner,type:'Team'}});
const match=()=>({id:1,name:'Synthetic',videogame:{slug:'dota-2'},status:'finished',forfeit:false,number_of_games:3,match_type:'best_of',draw:false,game_advantage:null,
 begin_at:'2026-01-02T10:00:00Z',end_at:'2026-01-02T12:45:00Z',winner_id:10,winner_type:'Team',
 opponents:[{type:'Team',opponent:{id:20,name:'B'}},{type:'Team',opponent:{id:10,name:'A'}}],results:[{team_id:20,score:1},{team_id:10,score:2}],games:[game(3,10),game(1,20),game(2,10)]});
test('series winner differs from first map; swapped source order and expected A/B are respected',()=>{
 expect(checkPandaSeriesResult(match(),expected,fetchedAt)).toMatchObject({status:'verified_provider_result',teamAWon:true,scoreA:2,scoreB:1,providerGameIds:['101','102','103'],canonicalProOutcome:false});
 expect(checkPandaSeriesResult(match(),{...expected,teamA:'20',teamB:'10'},fetchedAt)).toMatchObject({teamAWon:false,scoreA:1,scoreB:2});
 expect(checkPandaSeriesResult({...match(),end_at:'2026-01-02T12:44:59Z'},expected,fetchedAt)).toMatchObject({status:'verified_provider_result',
  endedAt:'2026-01-02T12:45:00.000Z',reportedEndedAt:'2026-01-02T12:44:59.000Z',warnings:['SERIES_END_BEFORE_LAST_MAP_END']});
});
test('missing decisive map, conflicting result, changed teams, unknown format and technical results are rejected',()=>{
 const m=match();for(const patch of [{games:[game(1,20),game(2,10)]},{winner_id:20},{results:[{team_id:10,score:1},{team_id:20,score:2}]},
  {number_of_games:2},{forfeit:true},{game_advantage:1},{status:'running'},{games:[game(1,20),game(1,10),game(3,10)]},{end_at:'2099-01-01T00:00:00Z'}]){
   expect(checkPandaSeriesResult({...m,...patch},expected,fetchedAt).status).toBe('unavailable');
  }
 expect(checkPandaSeriesResult(m,{...expected,teamA:'99'},fetchedAt).status).toBe('unavailable');
});
test('2:0 can leave an unplayed placeholder but cannot have a played third map or overlap',()=>{
 const m={...match(),results:[{team_id:10,score:2},{team_id:20,score:0}],games:[game(1,10),game(2,10),{...game(3,20),status:'not_started',finished:false,begin_at:null,end_at:null,winner:null}]};
 expect(checkPandaSeriesResult(m,expected,fetchedAt).status).toBe('verified_provider_result');
 expect(checkPandaSeriesResult({...m,games:[game(1,10),game(2,10),game(3,20)]},expected,fetchedAt)).toMatchObject({reason:'SERIES_GAME_AFTER_DECISION'});
 expect(checkPandaSeriesResult({...match(),games:[game(1,20),{...game(2,10),begin_at:'2026-01-02T10:30:00Z'},game(3,10)]},expected,fetchedAt).status).toBe('unavailable');
});
