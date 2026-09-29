/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scopes, selectPlan, suites } from '../scripts/verification-plan'
import { artifactDirectory, executePlan, runCommand } from '../scripts/verification-runner.mjs'

const files = (args: string[]) => selectPlan(args).groups.flatMap((group) => group.files)

test('every spec is assigned once; fast checks exclude services, Electron, RAW and benchmarks', async () => {
  const specs = (await readdir('tests'))
    .filter((file) => file.endsWith('.spec.ts'))
    .map((file) => `tests/${file}`)
    .sort()
  expect(suites.map((suite) => suite.file).sort()).toEqual(specs)
  const fast = selectPlan(['--fast'])
  expect(fast.groups.map((group) => group.name)).toEqual(['node'])
  expect(fast.build).toBe(false)
  expect(fast.mcp).toBe(false)
  expect(files(['--full'])).toHaveLength(
    specs.length - suites.filter((suite) => suite.group === 'benchmark').length,
  )
  expect(selectPlan(['--full']).mcp).toBe(true)
})

test('explicit scope selection is a deduplicated union and rejects misspellings', () => {
  for (const scope of scopes) {
    expect(files([scope, scope])).toEqual(files([scope]))
    expect(files([scope])).toEqual(expect.arrayContaining(files(['--fast'])))
  }
  expect(new Set(files(['ui', 'preview', 'adjustments']))).toEqual(
    new Set([...files(['ui']), ...files(['preview']), ...files(['adjustments'])]),
  )
  expect(files(['ui'])).not.toContain('tests/import-raw.spec.ts')
  expect(files(['ui'])).not.toContain('tests/adjustment-renderer-raw-ui.spec.ts')
  expect(selectPlan(['mcp']).mcp).toBe(true)
  expect(() => selectPlan([])).toThrow('Choose scopes')
  expect(() => selectPlan(['prevue'])).toThrow('Choose scopes')
  expect(() => selectPlan(['--full', 'ui'])).toThrow()
  expect(() => selectPlan(['--adjustment-benchmark', 'unknown'])).toThrow()
  for (const name of ['shadows', 'whites', 'blacks'])
    expect(selectPlan(['--adjustment-benchmark', name]).grep).toBe(`warmed RAW ${name} gestures`)
  const benchmark = selectPlan(['--adjustment-benchmark', 'highlights'])
  expect(benchmark.groups.flatMap((group) => group.files)).toEqual([
    'tests/adjustment-benchmark.spec.ts',
  ])
  expect(benchmark.grep).toBe('warmed RAW highlights gestures')
})

test('build is shared with MCP, failure stops dependent work, and commands preserve nonzero status', async ({}, info) => {
  const invocations: string[] = []
  const run = async (_command: string, args: string[]) => {
    invocations.push(args.join(' '))
    return 0
  }
  const result = await executePlan(selectPlan(['--full']), {
    directory: info.outputPath('success'),
    run,
  })
  expect(result.exitCode).toBe(0)
  expect(invocations.filter((command) => command === 'run --silent build')).toHaveLength(1)
  expect(invocations.at(-1)).toBe('scripts/check-mcp.mjs --isolated')
  const failed = await executePlan(selectPlan(['mcp']), {
    directory: info.outputPath('failure'),
    run: async (_command, args, options) => {
      await writeFile(options.log, 'expected harness failure')
      return args.includes('build') ? 7 : 0
    },
  })
  expect(failed.exitCode).toBe(7)
  expect(failed.stages.some((stage) => stage.name === 'mcp')).toBe(false)
  const failedTests = await executePlan(selectPlan(['--full']), {
    directory: info.outputPath('failed-tests'),
    run: async (_command, args, options) => {
      await writeFile(options.log, 'expected test failure')
      return args.includes('--project=node') ? 1 : 0
    },
  })
  expect(failedTests.exitCode).toBe(1)
  expect(failedTests.stages.at(-1)?.name).toBe('node')

  expect(
    await runCommand(
      process.execPath,
      ['-e', 'console.error("preserved failure detail"); process.exit(9)'],
      {
        log: info.outputPath('exit.log'),
      },
    ),
  ).toBe(9)
  expect(await readFile(info.outputPath('exit.log'), 'utf8')).toContain('preserved failure detail')
})

test('run artifacts survive subsequent runs and launcher refuses an occupied debug port', async ({}, info) => {
  const first = await artifactDirectory('harness')
  const second = await artifactDirectory('harness')
  const profile = await mkdtemp(join(tmpdir(), 'luma-launcher-check-'))
  const server = createServer()
  try {
    expect(first).not.toBe(second)
    const beforePlan = await readdir('artifacts/verification')
    expect(
      await runCommand(process.execPath, ['scripts/verify.mjs', '--plan', 'ui', 'preview', 'ui'], {
        log: info.outputPath('plan.log'),
      }),
    ).toBe(0)
    expect(JSON.parse(await readFile(info.outputPath('plan.log'), 'utf8'))).toEqual(
      JSON.parse(JSON.stringify(selectPlan(['ui', 'preview']))),
    )
    expect(await readdir('artifacts/verification')).toEqual(beforePlan)

    await writeFile(join(first, 'evidence.json'), 'benchmark evidence')
    expect(await readFile(join(first, 'evidence.json'), 'utf8')).toBe('benchmark evidence')
    // Occupied ports must fail before launching Electron or touching any profile.
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        error.code === 'EADDRINUSE' ? resolve() : reject(error),
      )
      server.listen(9222, '127.0.0.1', resolve)
    })
    expect(
      await runCommand(
        process.execPath,
        ['scripts/dev-mcp.mjs', '--', `--user-data-dir=${profile}`],
        { log: info.outputPath('launcher.log') },
      ),
    ).toBe(1)
    expect(await readFile(info.outputPath('launcher.log'), 'utf8')).toContain(
      'Port 9222 is already in use',
    )
    expect(await readdir(profile)).toEqual([])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await Promise.all(
      [first, second, profile].map((path) => rm(path, { recursive: true, force: true })),
    )
  }
  await expect(access(profile)).rejects.toThrow()
})

test('runner kills leftover child processes after command completion', async ({}, info) => {
  const pidFile = info.outputPath('child.pid')
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));child.unref()`
  expect(
    await runCommand(process.execPath, ['-e', script, pidFile], {
      log: info.outputPath('cleanup.log'),
    }),
  ).toBe(0)
  const pid = Number(await readFile(pidFile, 'utf8'))
  await expect
    .poll(async () => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
        return stat.split(' ')[2] === 'Z'
      } catch {
        return true
      }
    })
    .toBe(true)
})
