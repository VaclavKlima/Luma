import type { VerificationPlan } from './verification-plan'
import type { VerificationResult } from './verification-types'
export const INCOMPLETE_EXIT_CODE: number
export function artifactDirectory(label?: string): Promise<string>
export function acquireInvocationLock(
  artifacts: string,
  lockDirectory?: string,
): Promise<() => Promise<void>>
export function runCommand(
  command: string,
  args: string[],
  options: { log: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<number>
export function executePlan(
  plan: VerificationPlan,
  options?: {
    directory?: string
    run?: typeof runCommand
    lockDirectory?: string
    signal?: AbortSignal
    now?: () => number
  },
): Promise<VerificationResult>
