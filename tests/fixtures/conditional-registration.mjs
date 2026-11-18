export function registrationFixture(){
 const sha='a'.repeat(64),from='2030-01-01T00:00:00.000Z',until='2030-01-29T00:00:00.000Z',assessmentAt='2030-02-05T00:00:00.000Z';
 const plan={format:'conditional-registration-plan-v1',syntheticOnly:true,window:{from,until,assessmentAt},
  scope:[{editionKey:'synthetic-main',leagueId:'20',stage:'main_event',earliestSeriesAt:from,evidenceSha256:sha,evidenceObservedAt:'2029-12-29T00:00:00.000Z'}],
  policySha256:'77fa352544f4938e8b1cd69a2772894cff6b34df4b954e97677d36ea10ce388f',
  candidateSha256:'9eb1e2c0c7736aab9afefdf15972d539f22173ba9569d01620712371a635167b',
  exposure:{sha256:'ddffc46af97c411bba20e5d3c407a30584f8be076e8511f866df3eb73173c9e3',maps:5674,series:1768},
  executable:{capturedAt:'2029-12-30T00:00:00.000Z',code:{'tools/research/conditional_future_evaluate.py':sha,'tools/research/conditional-evaluator.mjs':sha,
   'tools/research/conditional-evaluation.mjs':sha,'tools/research/conditional-enrollment.mjs':sha,'tools/research/conditional-future-source-binding.mjs':sha,
   'tools/research/conditional-future-holdout.mts':sha,'tools/research/player-hero-inference.mts':sha,'pnpm-lock.yaml':sha},
   environmentSha256:sha},sourceReadinessSha256:sha};
 const registeredAt='2029-12-31T00:00:00.000Z';
 const execution={format:'conditional-assessment-binding-v1',syntheticOnly:true,manifestSha256:sha,inputSha256:sha,reportSha256:sha,
  policySha256:plan.policySha256,candidateSha256:plan.candidateSha256,exposureSha256:plan.exposure.sha256,code:structuredClone(plan.executable.code),
  environmentSha256:sha,scope:[{leagueId:'20',editionKey:'synthetic-main'}],window:{fromAt:from,until},
  schedule:{registeredAt,from,until,assessmentAt,assessedAt:assessmentAt},status:'insufficient',scoringPerformed:true,
  releaseGatePassed:false,activationAllowed:false,deployable:false};
 return {plan,registeredAt,execution,recordedAt:'2030-02-05T00:00:01.000Z'};
}
