import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, realpath, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('isolated HDR diagnostic preserves the sandbox, denies unrelated permissions, and reports fallback', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'luma-hdr-test-'))
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    desktop = await electron.launch({
      args: [resolve('out/main/hdr-diagnostic.js'), `--user-data-dir=${profile}`],
      env,
      chromiumSandbox: true,
      offline: true,
    })
    expect(await realpath(await desktop.evaluate(({ app }) => app.getPath('userData')))).toBe(
      await realpath(profile),
    )
    const security = await desktop.evaluate(({ app, BrowserWindow }) => ({
      prefs: (
        BrowserWindow.getAllWindows()[0].webContents as unknown as {
          getLastWebPreferences(): Electron.WebPreferences
        }
      ).getLastWebPreferences(),
      noSandbox: app.commandLine.hasSwitch('no-sandbox'),
      forcedColorProfile: app.commandLine.getSwitchValue('force-color-profile'),
      enabledFeatures: app.commandLine.getSwitchValue('enable-features'),
    }))
    expect(security.noSandbox).toBe(false)
    expect(security.forcedColorProfile).toBe('')
    expect(security.enabledFeatures).toBe('')
    expect(security.prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    })
    const page = await desktop.firstWindow()
    // Deterministic failure injection covers a missing adapter on any host GPU.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => null },
        configurable: true,
      })
    })
    await page.getByRole('button', { name: 'Recheck display' }).click()
    await expect(page.getByRole('status')).toContainText('No WebGPU adapter')
    for (const mode of ['hdr', 'sdr', 'auto']) {
      await page.getByLabel('Preview').selectOption(mode)
      await expect
        .poll(
          async () =>
            JSON.parse((await page.locator('#report').textContent()) || '{}').target.requested,
        )
        .toBe(mode)
      await expect
        .poll(async () => JSON.parse((await page.locator('#report').textContent()) || '{}').state)
        .toBe('unavailable')
      const value = JSON.parse((await page.locator('#report').textContent()) || '{}')
      expect(value.target.mode).toBe('sdr')
      expect(value.physicalOutputVerified).toBe(false)
    }
    expect(
      await page.evaluate(
        async () => (await navigator.permissions.query({ name: 'geolocation' })).state,
      ),
    ).toBe('denied')
    expect(
      await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
        node: 'require' in window,
        library: 'luma' in window,
      })),
    ).toMatchObject({ width: 1100, height: 700, overflow: false, node: false, library: false })
    expect(await readdir(profile)).not.toContain('library')
  } finally {
    await desktop?.close()
    await rm(profile, { recursive: true, force: true })
  }
})
