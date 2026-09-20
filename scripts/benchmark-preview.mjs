// Retain the direct script entry point with the same isolated runner.
import { executePlan } from './verification-runner.mjs'
import { selectPlan } from './verification-plan.ts'
process.exitCode = (await executePlan(selectPlan(['--benchmark']))).exitCode
