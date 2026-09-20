import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

export async function artifactDirectory(label = 'run') {
  const root = resolve('artifacts/verification')
  await mkdir(root, { recursive: true })
  return mkdtemp(join(root, `${new Date().toISOString().replaceAll(':', '-')}-${label}-`))
}

export function runCommand(command, args, { log, env = process.env } = {}) {
  return new Promise((resolveResult, reject) => {
    const output = openSync(log, 'w')
    const child = spawn(command, args, { env, stdio: ['ignore', output, output], detached: true })
    closeSync(output)
    const stop = (signal) => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    const interrupt = () => stop('SIGINT')
    const terminate = () => stop('SIGTERM')
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    child.once('error', reject)
    child.once('close', (code, signal) => {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
      // Reap lingering workers after a failed or interrupted command too.
      stop('SIGKILL')
      resolveResult(code ?? (signal ? 130 : 1))
    })
  })
}

export async function executePlan(plan, { directory, run = runCommand } = {}) {
  const started = Date.now()
  const artifacts = directory ?? (await artifactDirectory(plan.benchmark ? 'benchmark' : 'check'))
  await mkdir(artifacts, { recursive: true })
  const stages = []
  let exitCode = 0
  const baseEnv = { ...process.env, LUMA_VERIFICATION_DIR: artifacts, LUMA_PREVIEW_BENCHMARK: '0' }
  const stage = async (name, command, args, env = baseEnv) => {
    const start = Date.now()
    const log = join(artifacts, `${name}.log`)
    const code = await run(command, args, { log, env })
    stages.push({ name, code, durationMs: Date.now() - start, log })
    if (code) {
      exitCode ||= code
      const excerpt = await readFile(log, 'utf8').catch(() => '')
      console.error(
        `${name} failed (${code}). ${log}\n${excerpt.split('\n').slice(-35).join('\n')}`,
      )
    }
    return code
  }
  if (plan.staticChecks) {
    await Promise.all(
      ['typecheck', 'lint', 'format:check'].map((name) =>
        stage(name.replace(':', '-'), 'npm', ['run', '--silent', name]),
      ),
    )
  }
  if (!exitCode && plan.build) await stage('build', 'npm', ['run', '--silent', 'build'])
  const counts = { passed: 0, failed: 0, skipped: 0 }
  for (const group of plan.groups) {
    if (exitCode) break
    const args = [
      require.resolve('@playwright/test/cli'),
      'test',
      `--project=${group.name}`,
      ...group.files,
    ]
    if (group.name === 'node') args.push('--workers=2')
    if (plan.grep) args.push('--grep', plan.grep)
    await stage(group.name, process.execPath, args, {
      ...baseEnv,
      LUMA_TEST_GROUP: group.name,
      ...(plan.benchmark ? { LUMA_PREVIEW_BENCHMARK: '1', LUMA_TEST_TRACE: '0' } : {}),
    })
    const summary = await readFile(join(artifacts, group.name, 'summary.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null)
    if (summary) for (const key of Object.keys(counts)) counts[key] += summary[key]
  }
  if (!exitCode && plan.mcp)
    await stage('mcp', process.execPath, ['scripts/check-mcp.mjs', '--isolated'])
  const result = {
    scope: plan.label,
    exitCode,
    ...counts,
    durationMs: Date.now() - started,
    artifacts,
    stages,
  }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(
    `${exitCode ? 'FAILED' : 'Passed'} [${plan.label}]: ${counts.passed} tests passed, ${counts.failed} failed, ${counts.skipped} skipped; ${stages.filter((s) => !s.code).length}/${stages.length} stages; ${(result.durationMs / 1000).toFixed(1)}s\nArtifacts: ${artifacts}`,
  )
  return result
}
