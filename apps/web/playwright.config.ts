import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
 testDir:'./tests/e2e',
 fullyParallel:true,
 reporter: process.env.CI ? 'github' : 'list',
 use:{baseURL:'http://127.0.0.1:5173',trace:'retain-on-failure',...devices['Desktop Chrome']},
 projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
 webServer:[
   {command:'pnpm --filter @dota/api dev',url:'http://127.0.0.1:3000/health',reuseExistingServer:!process.env.CI,timeout:60000},
   {command:'pnpm --filter @dota/web dev',url:'http://127.0.0.1:5173',reuseExistingServer:!process.env.CI,timeout:60000}
 ]
});
