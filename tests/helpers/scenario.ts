import {ScenarioInputSchema} from '../../packages/contracts/src/scenario.js';
import {compareInput} from './compare.js';
export function scenarioInput(){
  const {fromAt:_from,...q}=compareInput();
  return ScenarioInputSchema.parse({...q,title:'Synthetic single map',scheduledAt:null,confirmedByOwner:true,expectedLineupA:null,expectedLineupB:null,
    context:{seriesId:null,mapNumber:null,teamASeriesWinsBefore:null,teamBSeriesWinsBefore:null,radiantSlot:null,firstPickSlot:null,venueKind:null,tournamentStage:null}});
}
