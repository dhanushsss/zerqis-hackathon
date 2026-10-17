import { defineConfig } from '@playwright/test';

// Ordinary E2E runs must never make paid cloud calls: blank the keys for the spawned server
// (dotenv does not override variables that are already set). Opt in with ALIBI_E2E_LIVE=1.
const live = process.env.ALIBI_E2E_LIVE === '1';

export default defineConfig({
  testDir: 'e2e',
  timeout: 300_000,
  use: { baseURL: 'http://127.0.0.1:8790', trace: 'retain-on-failure' },
  webServer: {
    command: `npm run build -w web && ${live ? '' : 'NEBIUS_API_KEY= TAVILY_API_KEY= GITHUB_TOKEN= '}ALIBI_DB=e2e.db PORT=8790 npx tsx server/src/index.ts`,
    url: 'http://127.0.0.1:8790/api/health',
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
