// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,   // one retry on CI to absorb network flakiness
  workers: 1,                        // run serially – it's a live site
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'https://uxarmy.com',
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
