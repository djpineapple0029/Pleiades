import { defineConfig, devices } from '@playwright/test'

// Accounts end to end (USERS.md milestone 2): the account shell, opening a
// server map and autosave, against a Flask of its own with accounts switched
// on. Its config and database live in the gitignored artifacts/ and start
// empty every run; it never touches config/ or a dev backend on :5001.
// Vite proxies /api to it (PLEIADES_API in vite.config.js). Loopback counts as
// a secure context, so the Secure session cookie works over http here.
const SWIFTSHADER_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
const API_PORT = 5190
const APP_PORT = 5181
const DIR = 'artifacts/e2e-accounts'

export default defineConfig({
  testDir: 'tests/e2e/accounts',
  timeout: process.env.CI ? 360_000 : 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command:
        `cd .. && rm -rf ${DIR} && mkdir -p ${DIR} && ` +
        `printf '[accounts]\\nenabled = true\\nsignup_open = true\\n' > ${DIR}/pleiades.toml && ` +
        `PLEIADES_CONFIG=${DIR}/pleiades.toml PLEIADES_PORT=${API_PORT} uv run python -m server`,
      url: `http://127.0.0.1:${API_PORT}/api/auth/me`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `PLEIADES_API=http://127.0.0.1:${API_PORT} npx vite --port ${APP_PORT} --strictPort`,
      url: `http://localhost:${APP_PORT}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: 'accounts',
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        launchOptions: { args: SWIFTSHADER_ARGS },
      },
    },
  ],
})
