import type { VerificationPlan } from './verification-plan'
export function artifactDirectory(label?: string): Promise<string>
export function runCommand(
  command: string,
  args: string[],
  options: { log: string; env?: NodeJS.ProcessEnv },
): Promise<number>
export function executePlan(
  plan: VerificationPlan,
  options?: { directory?: string; run?: typeof runCommand },
): Promise<{
  scope: string
  exitCode: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
  artifacts: string
  stages: { name: string; code: number; durationMs: number; log: string }[]
}>
