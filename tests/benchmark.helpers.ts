import type { TestInfo } from '@playwright/test'
import type { BenchmarkRecord } from '../scripts/verification-types'

// Measurements are attachments even when a subsequent regression assertion fails.
// Original per-benchmark JSON files remain the detailed evidence and baseline input.
export async function recordBenchmark(info: TestInfo, record: BenchmarkRecord) {
  await info.attach(`benchmark:${record.family}`, {
    body: JSON.stringify(record),
    contentType: 'application/json',
  })
  for (const path of record.evidence)
    await info.attach('Benchmark measurements', { path, contentType: 'application/json' })
}
