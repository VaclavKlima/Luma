import { selectPlan } from './verification-plan.ts'
import { executePlan } from './verification-runner.mjs'
try {
  const plan = selectPlan(process.argv.slice(2))
  if (process.argv.includes('--plan')) console.log(JSON.stringify(plan, null, 2))
  else process.exitCode = (await executePlan(plan)).exitCode
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
