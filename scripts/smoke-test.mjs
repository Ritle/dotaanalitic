const url = process.env.SMOKE_HEALTH_URL || 'http://127.0.0.1:3000/health';
const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
if (!response.ok) throw new Error(`Health endpoint returned ${response.status}`);
const data = await response.json();
if (data.status !== 'ok' || data.service !== 'dota2-pro-analytics-api') throw new Error(`Invalid health response: ${JSON.stringify(data)}`);
console.log(`SMOKE PASS ${url}`);
