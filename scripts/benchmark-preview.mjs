import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const result = spawnSync(
  process.execPath,
  [require.resolve('@playwright/test/cli'), 'test', 'tests/preview-benchmark.spec.ts'],
  {
    env: { ...process.env, LUMA_PREVIEW_BENCHMARK: '1' },
    stdio: 'inherit',
  },
)
process.exitCode = result.status ?? 1
