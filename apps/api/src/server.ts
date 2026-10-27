import { buildApp } from './app.js';
const app = await buildApp();
const port = Number(process.env.API_PORT ?? 3000);
const host = process.env.API_HOST ?? '127.0.0.1';
await app.listen({ port, host });
