import { DatasetBuildRequestSchema, type DatasetBuildRequest } from '@dota/contracts';
export type DatasetSplit = 'train'|'calibration'|'validation'|'test';
export type SplitMember = { matchId:string; seriesId:string|null; startedAt:string };
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
    if (row.seriesId !== null) {
      const group=groups.get(row.seriesId)??new Set<DatasetSplit|null>();
      group.add(splitAt(row.startedAt,request)); groups.set(row.seriesId,group);
    }
  }
  return members.filter(row=>splitAt(row.startedAt,request)!==null).map(row=>{
    const group=row.seriesId===null?null:groups.get(row.seriesId)!;
    const reason=group===null?'SERIES_UNKNOWN':group.has(null)?'SERIES_OUTSIDE_WINDOW':
      group.size>1?'SERIES_CROSSES_SPLIT':null;
    return {...row,split:reason===null?splitAt(row.startedAt,request):null,reason};
  });
}
