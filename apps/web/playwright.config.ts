import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:5179', trace: 'off', ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @dota/web dev --port 5179',
    url: 'http://127.0.0.1:5179',
    env: { API_PROXY_TARGET: 'http://127.0.0.1:3151' },
    reuseExistingServer: false,
    timeout: 60000
  }
});
