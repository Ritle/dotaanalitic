export const stage = (id,name) => ({id,name,serie_id:123,league_id:4125});
// Synthetic provider records. The IDs have no connection to the real edition.
export function sample() {
  return {calendar:'<title>DreamLeague Season 30</title><p>Tournament Dates: 2 – 13 December 2026<br>Swiss Stage Dates: 2 – 7 December<br>Playoff Dates: 8 – 13 December</p><h2>Swiss Stage</h2><ul><li>6 swiss rounds with 24 teams</li><li>All series are best-of-three</li></ul>',
    valve:{infos:[{league_id:100,name:'DreamLeague Season 30'}]},opendota:[{leagueid:'100',name:'DreamLeague Season 30',tier:'premium'}],
    editions:[{id:123,name:null,slug:'dreamleague-30-2026',year:2026,season:'30',league_id:4125,league:{id:4125,name:'DreamLeague'},
      videogame:{slug:'dota-2'},tournaments:[stage(456,'Swiss Stage'),stage(457,'Playoffs')]}],
    page:{number:'1',size:'100',total:'1',hasNext:false}};
}
