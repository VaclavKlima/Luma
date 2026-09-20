import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter'

export default class VerificationReporter implements Reporter {
  private counts = { passed: 0, failed: 0, skipped: 0 }
  constructor(private options: { outputDir: string }) {}
  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === 'skipped') this.counts.skipped++
    else if (result.status === test.expectedStatus) this.counts.passed++
    else this.counts.failed++
  }
  onEnd(result: FullResult) {
    mkdirSync(this.options.outputDir, { recursive: true })
    writeFileSync(
      join(this.options.outputDir, 'summary.json'),
      JSON.stringify(
        { ...this.counts, status: result.status, durationMs: result.duration },
        null,
        2,
      ),
    )
  }
}
