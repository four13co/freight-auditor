import { defineConfig, devices } from '@playwright/test';

// Renders the real dashboard page against a mocked API (route interception,
// not a live backend) so this stays deterministic and needs no Postgres.
// Perceptual verdict only (86e2u7j1y is in-design, not blessed) -- no
// toHaveScreenshot baseline committed here.
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run preview -- --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
