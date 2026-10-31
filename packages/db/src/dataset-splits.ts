import { DatasetBuildRequestSchema, type DatasetBuildRequest } from '@dota/contracts';
export type DatasetSplit = 'train'|'calibration'|'validation'|'test';
export type SplitMember = { matchId:string; seriesId:string|null; startedAt:string;
  providerSeriesKey?:string|null; seriesConflict?:boolean; seriesOrganizationsKnown?:boolean };
export type ProviderSeriesAlias = { seriesId:string; provider:string|null; providerSeriesId:string|null;
  teamAId:string|null; teamBId:string|null };
const compareText=(a:string,b:string)=>a<b?-1:a>b?1:0;
const positiveId=(value:string|null):value is string=>value!==null && /^[1-9]\d{0,18}$/.test(value) && BigInt(value)<=9223372036854775807n;
export function providerSeriesKey(provider:string|null,id:string|null) {
  return provider!==null && /^[a-z][a-z0-9_-]{0,79}$/.test(provider) && positiveId(id)?provider+':'+id:null;
}
/** A grouping proof does not merge canonical series. Unknown organizations stay distinct from a contradiction. */
export function assessProviderSeriesAliases(input:readonly ProviderSeriesAlias[]) {
  const seen=new Set<string>(), groups=new Map<string,{pairs:Set<string>;unknown:boolean}>();
  const aliases=input.map(row=>{
    if(seen.has(row.seriesId)) throw new Error('duplicate_series_alias');
    seen.add(row.seriesId);
    const key=providerSeriesKey(row.provider,row.providerSeriesId);
    const pair=positiveId(row.teamAId) && positiveId(row.teamBId) && row.teamAId!==row.teamBId?
      [row.teamAId,row.teamBId].sort(compareText).join(':'):null;
    if(key!==null) {
      const group=groups.get(key)??{pairs:new Set<string>(),unknown:false};
      if(pair===null) group.unknown=true; else group.pairs.add(pair);
      groups.set(key,group);
    }
    return {...row,providerSeriesKey:key};
  });
  return aliases.map(row=>{
    const group=row.providerSeriesKey===null?null:groups.get(row.providerSeriesKey)!;
    return {...row,seriesConflict:group!==null && group.pairs.size>1,
      seriesOrganizationsKnown:group!==null && !group.unknown && group.pairs.size===1};
  }).sort((a,b)=>compareText(a.seriesId,b.seriesId));
}
const groupKey=(row:SplitMember)=>row.seriesId===null?null:
  row.providerSeriesKey===undefined?row.seriesId:row.providerSeriesKey;
export function splitAt(start:string, request:DatasetBuildRequest):DatasetSplit|null {
  if (start < request.fromAt || start >= request.toAt) return null;
  return start < request.trainUntil ? 'train' : start < request.calibrationUntil ? 'calibration' :
    start < request.validationUntil ? 'validation' : 'test';
}
/** Include all locally known members, including those outside the requested interval. */
export function assignDatasetSplits(members:readonly SplitMember[], input:DatasetBuildRequest) {
  const request=DatasetBuildRequestSchema.parse(input), seen=new Set<string>();
  const groups=new Map<string,Set<DatasetSplit|null>>();
  for (const row of members) {
    if (seen.has(row.matchId)) throw new Error('duplicate_split_map');
    seen.add(row.matchId);
    const key=groupKey(row);
    if (key !== null) {
      const group=groups.get(key)??new Set<DatasetSplit|null>();
      group.add(splitAt(row.startedAt,request)); groups.set(key,group);
    }
  }
  return members.filter(row=>splitAt(row.startedAt,request)!==null).map(row=>{
    const key=groupKey(row), group=key===null?null:groups.get(key)!;
    const reason=group===null?'SERIES_UNKNOWN':row.seriesConflict?'SERIES_ORGANIZATION_CONFLICT':
      row.seriesOrganizationsKnown===false?'SERIES_ORGANIZATIONS_UNKNOWN':group.has(null)?'SERIES_OUTSIDE_WINDOW':
      group.size>1?'SERIES_CROSSES_SPLIT':null;
    return {...row,split:reason===null?splitAt(row.startedAt,request):null,reason};
  });
}
