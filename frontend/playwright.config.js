import { defineConfig, devices } from '@playwright/test'

// Real WebGL2, forced onto SwiftShader (software) so pixel comparisons are
// identical everywhere: a real GPU would antialias and dither differently
// machine to machine. See tests/e2e/helpers/README.md for why this exists.
const SWIFTSHADER_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  // SwiftShader is a software GL rasterizer — CPU-bound, not GPU-bound.
  // Playwright's default worker count runs separate spec files in parallel
  // processes regardless of fullyParallel (that flag only serializes tests
  // *within* one file), so several of these specs fighting over the same
  // CPU cores causes exactly the cascading rAF-timeout flakiness this
  // suite is trying to avoid. One worker at a time is slower wall-clock but
  // actually deterministic.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5180',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite --port 5180 --strictPort',
    url: 'http://localhost:5180',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'swiftshader',
      testDir: 'tests/e2e/swiftshader',
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        launchOptions: { args: SWIFTSHADER_ARGS },
      },
    },
    {
      // Real pointer lock: chrome-headless-shell can't take one, so these run
      // headed. A visible Chromium window opens — run this project by hand
      // (`npm run test:e2e:headed`), not as part of the default test loop.
      // In CI this needs xvfb-run (V2.md §2.7.5, not set up yet).
      name: 'headed-lock',
      testDir: 'tests/e2e/headed-lock',
      use: {
        ...devices['Desktop Chrome'],
        headless: false,
      },
    },
  ],
})
