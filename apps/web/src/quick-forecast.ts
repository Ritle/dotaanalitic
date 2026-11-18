import {QuickForecastResponseSchema,QuickForecastFailureSchema,type QuickForecastRequest} from '../../api/src/modules/upcoming/quick-forecast-contract';
import {ownerAuth,accountAccess,AuthRequestError} from './auth';
import {queryClient} from './query-client';
export class QuickForecastFailure extends Error{
 constructor(readonly code:string,message:string,readonly leagueId:string|null=null){super(message);}
}
export async function requestQuickForecast(matchId:string,body:QuickForecastRequest,signal:AbortSignal){
 const response=await fetch(`/api/v1/upcoming/${matchId}/forecast`,{method:'POST',credentials:'same-origin',signal,
  headers:{'content-type':'application/json','x-csrf-token':ownerAuth.value?.csrfToken??''},body:JSON.stringify(body)});
 if(response.status===401){ownerAuth.value=null;accountAccess.value=null;queryClient.clear();throw new AuthRequestError(401,'Войдите снова.');}
 const value=await response.json();
 if(!response.ok){const error=QuickForecastFailureSchema.safeParse(value);throw new QuickForecastFailure(error.success?error.data.error.code:'HTTP_ERROR',
  error.success?error.data.error.message:'Не удалось получить результат. Повторите ту же попытку.',error.success?error.data.error.leagueId??null:null);}
 return QuickForecastResponseSchema.parse(value);
}
