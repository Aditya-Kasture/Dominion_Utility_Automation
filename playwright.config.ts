import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  testDir: './tests',
  // Run tests within each file sequentially — scraping portals can't be parallelized
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['html'], ['list']],
  timeout: 60_000,      // 60s per test step
  expect: { timeout: 15_000 },

  use: {
    headless: process.env.HEADLESS !== 'false',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Chromium-only for portal scraping — no need for cross-browser here
      },
    },
  ],

  // Create screenshots dir if it doesn't exist
  outputDir: 'test-results/',
});
