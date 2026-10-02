import { defineConfig, devices } from '@playwright/test'

// Multiplayer end to end (context/MOONSHOT.md, milestone 1): two and three
// browser contexts — different accounts — in one map through its live room.
// Like the accounts suite, a server of its own with accounts on, whose config
// and database live in the gitignored artifacts/ and start empty every run.
// Vite proxies /api and /ws to it. Headless only.
const SWIFTSHADER_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
const API_PORT = 5191
const APP_PORT = 5182
const DIR = 'artifacts/e2e-multiplayer'
export const ADMIN_PASSWORD = 'e2e admin password'
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`

export default defineConfig({
  testDir: 'tests/e2e/multiplayer',
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
        `printf '[accounts]\\nenabled = true\\nsignup_open = true\\n[admin]\\npassword = "${ADMIN_PASSWORD}"\\n' > ${DIR}/pleiades.toml && ` +
        `PLEIADES_CONFIG=${DIR}/pleiades.toml PLEIADES_PORT=${API_PORT} uv run python -m server`,
      url: `${API_ORIGIN}/api/auth/me`,
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
      name: 'multiplayer',
      use: {
        ...devices['Desktop Chrome'],
        // Two or three software-rendered (SwiftShader) pages at once: small
        // ones, since nothing here looks at pixels and big ones starve the CPU.
        viewport: { width: 480, height: 320 },
        headless: true,
        launchOptions: { args: SWIFTSHADER_ARGS },
      },
    },
  ],
})
