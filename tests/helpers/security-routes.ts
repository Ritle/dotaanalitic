/** Reviewed current owner HTTP surface. No requests here carry valid domain mutations. */
export const ownerReadRoutes = [
  '/api/v1/auth/me', '/api/v1/teams', '/api/v1/players', '/api/v1/heroes',
  '/api/v1/teams/:id', '/api/v1/players/:id', '/api/v1/teams/:id/matches', '/api/v1/players/:id/matches',
  '/api/v1/players/:id/heroes', '/api/v1/teams/:id/strength', '/api/v1/scenarios', '/api/v1/scenarios/:id',
  '/api/v1/scenarios/:id/history', '/api/v1/scenarios/:id/analyses', '/api/v1/analyses/:id',
  '/api/v1/scenarios/:id/predictions', '/api/v1/scenarios/:id/predictions/:requestId',
  '/api/v1/forecast-journal', '/api/v1/forecast-journal/:requestId', '/api/v1/upcoming', '/api/v1/upcoming/tournaments/:id',
  '/api/v1/upcoming/:id/target-preview', '/api/v1/upcoming/:id/targets', '/api/v1/schedule-targets/:requestId',
  '/api/v1/schedule-targets/:targetId/forecasts', '/api/v1/schedule-targets/:targetId/forecasts/:requestId',
  '/api/v1/schedule-targets/:targetId/forecasts/:forecastId/result-binding', '/api/v1/schedule-targets/:targetId/forecasts/:forecastId/outcomes',
  '/api/v1/schedule-targets/:targetId/lifecycle', '/api/v1/teams/:id/history-refresh', '/api/v1/models/readiness',
] as const;
export const ownerWriteRoutes = [
  ...['/api/v1/auth/logout', '/api/v1/teams/compare', '/api/v1/teams/:id/roster-cohesion',
    '/api/v1/scenarios', '/api/v1/scenarios/draft-check', '/api/v1/scenarios/:id/hero-matchups',
    '/api/v1/scenarios/:id/analyses', '/api/v1/scenarios/:id/predictions', '/api/v1/forecast-journal',
    '/api/v1/upcoming/refresh', '/api/v1/upcoming/tournaments/:id/refresh', '/api/v1/schedule-targets',
    '/api/v1/schedule-targets/:targetId/forecasts', '/api/v1/schedule-targets/:targetId/forecasts/:forecastId/result-binding',
    '/api/v1/schedule-targets/:targetId/forecasts/:forecastId/outcomes', '/api/v1/schedule-targets/:targetId/lifecycle',
    '/api/v1/teams/:id/history-refresh'].map(url => ({ method: 'POST' as const, url })),
  { method: 'PUT' as const, url: '/api/v1/scenarios/:id' },
];
export const routeExample = (path: string) => path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000001');
