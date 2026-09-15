import { defineConfig, devices } from '@playwright/test'

// Against the real build, served by Flask — the two suites here (save/open,
// HTML export) exercise the production asset pipeline, not the Vite dev
// server. `reuseExistingServer: false` on purpose: CLAUDE.md's "stale build"
// gotcha is exactly a test suite silently reusing an old server would hit.
// If :5001 is already bound, this fails loudly instead of testing stale code
// — run `lsof -iTCP:5001 -sTCP:LISTEN` first if it does.
export default defineConfig({
  testDir: 'tests/e2e/prod',
  timeout: 90_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5001',
    headless: false, // real pointer lock; needs a visible window and xvfb in CI
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && (cd .. && uv run python -m server)',
    url: 'http://127.0.0.1:5001',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: 'prod', use: { ...devices['Desktop Chrome'] } }],
})
