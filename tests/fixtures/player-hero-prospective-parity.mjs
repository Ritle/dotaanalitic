// Deterministic synthetic stress cases for the independent Python arithmetic oracle.
import {writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {featureFixture,bindFeatureEvidence} from './player-hero-prospective-features.mjs';
import {rebind,T,day} from './player-hero-prospective-input.mjs';
import {createProspectiveCapture} from '../../.tools/s304-prospective-capture-runtime/player-hero-prospective-capture.mjs';
import {buildProspectivePlayerHeroFeatures} from '../../.tools/s304-prospective-features-runtime/player-hero-prospective-features.mjs';
import {infer} from '../../.tools/s304-prospective-features-runtime/player-hero-inference.mjs';
export function parityCases(){
  const artifact=JSON.parse(readFileSync(new URL('../../.tools/s304-hero-fit-r1/artifact.json',import.meta.url)));
  return Array.from({length:24},(_,seed)=>{
    const input=featureFixture(),raw=structuredClone(input.capture.input);
    let state=seed+1;const random=()=>{state=(state*1664525+1013904223)>>>0;return state;};
    while(raw.history.maps.length<8){
      const i=raw.history.maps.length,m=structuredClone(raw.history.maps[0]),h=structuredClone(input.history.maps[0]);
      m.matchId=String(9007199254741000n+BigInt(i));h.matchId=m.matchId;h.seriesKey='synthetic-extra:'+i;
      raw.history.maps.push(m);raw.historyObservations.push({...raw.historyObservations[0],matchId:m.matchId});
      input.history.maps.push(h);input.outcomeObservations.push({...input.outcomeObservations[0],matchId:m.matchId});
    }
    for(let i=0;i<8;i++){
      const m=raw.history.maps[i],h=input.history.maps[i],o=raw.historyObservations[i],e=input.outcomeObservations[i];
      // Overlapping maps and exact start/completion ties exercise frozen-at-start replay.
      const start=T-20n*day+BigInt(i)*day/4n,end=start+BigInt(1+seed%4)*day/4n;
      m.startedAtUs=h.startedAtUs=String(start);m.completedAtUs=h.completedAtUs=String(end);
      m.fetchedAtUs=h.fetchedAtUs=String(end+1000n);m.knownAtUs=String(end+500n);
      o.fetchedAtUs=m.fetchedAtUs;o.observedAtUs=String(end+2000n);o.recordedAtUs=String(end+3000n);
      h.labelVerifiedAtUs=String(end+1500n);e.observedAtUs=String(end+2000n);e.recordedAtUs=String(end+3000n);
      const roster=structuredClone(m.players);
      for(let k=9;k>0;k--){const j=random()%(k+1);[roster[k],roster[j]]=[roster[j],roster[k]];}
      h.teamA=roster.slice(0,5).map(({playerId,accountId})=>({playerId,accountId}));
      h.teamB=roster.slice(5).map(({playerId,accountId})=>({playerId,accountId}));
      h.teamAWon=random()%3!==0;
      for(const p of m.players)if(random()%3===0)p.heroId=50+Number(p.playerId);
    }
    if(seed%4===1)input.outcomeObservations[0].recordedAtUs=String(T);
    if(seed%4===2){input.history.maps[1].seriesKey=input.history.maps[0].seriesKey;input.outcomeObservations[0].recordedAtUs=String(T);}
    if(seed%4===3)for(const e of input.outcomeObservations.slice(0,4))e.recordedAtUs=String(T);
    if(seed%2)[raw.scenario.teamA,raw.scenario.teamB]=[raw.scenario.teamB,raw.scenario.teamA];
    input.capture=createProspectiveCapture(rebind(raw));bindFeatureEvidence(input);
    const result=buildProspectivePlayerHeroFeatures(input);
    return {seed,input,result,researchOnlyScores:result.inputs?Object.fromEntries(['H1','H2'].map(name=>[name,infer(artifact.models[name],name,result.inputs)])):null};
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  writeFileSync(new URL('../../.tools/s304-prospective-feature-parity-cases.json',import.meta.url),JSON.stringify(parityCases()),{flag:'wx'});
  console.log('24 synthetic parity cases saved; no real target scoring');
}
