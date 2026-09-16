import { readFile } from 'node:fs/promises'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { LumaApi } from '../src/shared/contracts'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

async function resizeWindow(app: ElectronApplication, page: Page, width: number, height: number) {
  const window = await app.browserWindow(page)
  await window.evaluate(
    (browserWindow, size) => {
      browserWindow.unmaximize()
      browserWindow.setContentSize(size.width, size.height)
    },
    { width, height },
  )
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
}

async function expectInsideWindow(locator: Locator, width: number, height: number) {
  await expect(locator).toBeVisible()
  const bounds = await locator.boundingBox()
  expect(bounds).not.toBeNull()
  if (!bounds) throw new Error('The visible element must have layout bounds.')
  expect(bounds.width).toBeGreaterThan(0)
  expect(bounds.height).toBeGreaterThan(0)
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(height + 1)
}

test('starts the built desktop application with its isolated preload bridge', async ({ luma }) => {
  const { app, page } = luma
  const packageInfo = JSON.parse(await readFile('package.json', 'utf8')) as { version: string }
  await expect(page).toHaveTitle('Luma')
  expect(page.url()).toMatch(/^file:\/\//)
  expect(app.windows()).toHaveLength(1)

  const nativeInfo = await app.evaluate(({ app }) => {
    return {
      version: app.getVersion(),
      platform: process.platform,
      userData: app.getPath('userData'),
      noSandbox: app.commandLine.hasSwitch('no-sandbox'),
      debugPort: app.commandLine.getSwitchValue('remote-debugging-port'),
    }
  })
  expect(nativeInfo).toMatchObject({
    version: packageInfo.version,
    userData: luma.userDataDir,
    noSandbox: false,
  })
  // Playwright owns an ephemeral debugging endpoint; the fixed MCP port is development-only.
  expect(nativeInfo.debugPort).not.toBe('9222')
  const bridge = await page.evaluate(async () => {
    const luma = (window as unknown as { luma: LumaApi }).luma
    return {
      info: await luma.getAppInfo(),
      keys: Object.keys(luma),
      hasRequire: 'require' in window,
      hasProcess: 'process' in window,
    }
  })
  expect(bridge).toEqual({
    info: { version: nativeInfo.version, platform: nativeInfo.platform },
    keys: [
      'getLensSettings',
      'updateLensSettings',
      'getAppInfo',
      'listPhotos',
      'locatePhoto',
      'getPhotoRange',
      'requestFullPreview',
      'releaseFullPreview',
      'requestCachedFullPreview',
      'deletePhotos',
      'listTasks',
      'cancelTask',
      'dismissTask',
      'getTaskErrors',
      'chooseSource',
      'getReview',
      'selectCandidates',
      'importSelected',
      'cancelImport',
      'disposeImport',
      'onLibraryEvent',
    ],
    hasRequire: false,
    hasProcess: false,
  })
  await expect(page.getByTestId('app-version')).toContainText(nativeInfo.version)
  await expect(page.getByTestId('empty-library')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import photos', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => window.luma.listPhotos())).toEqual({ photos: [], total: 0 })
})

for (const [width, height] of [
  [1280, 800],
  [1920, 1080],
]) {
  test(`keeps the workspace and console usable at ${width} × ${height}`, async ({
    luma,
  }, testInfo) => {
    const { app, page } = luma
    await importPhotos(app, page)
    await resizeWindow(app, page, width, height)
    for (const id of ['photo-library', 'workspace', 'adjustments-panel', 'console-toggle']) {
      await expectInsideWindow(page.getByTestId(id), width, height)
    }
    await expect(page.getByTestId('console-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('console-panel')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`workspace-${width}x${height}.png`) })

    await page.getByTestId('console-toggle').click()
    await expect(page.getByTestId('console-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expectInsideWindow(page.getByTestId('console-panel'), width, height)
    await expect(page.getByTestId('console-panel')).toContainText(/disconnected/i)
    await expect(page.getByTestId('console-panel').locator('.xterm')).toBeVisible()
    await expect(page.getByTestId('main-preview')).toBeVisible()

    await resizeWindow(app, page, 1100, 700)
    for (const id of ['photo-library', 'workspace', 'adjustments-panel', 'console-panel']) {
      await expectInsideWindow(page.getByTestId(id), 1100, 700)
    }
    await expectInsideWindow(page.getByTestId('console-panel').locator('.xterm-screen'), 1100, 700)
    await resizeWindow(app, page, width, height)
    await expectInsideWindow(
      page.getByTestId('console-panel').locator('.xterm-screen'),
      width,
      height,
    )
    await page.screenshot({ path: testInfo.outputPath(`console-${width}x${height}.png`) })

    await page.getByTestId('console-toggle').click()
    await expect(page.getByTestId('console-panel')).toHaveCount(0)
    await expect(page.getByTestId('console-toggle')).toHaveAttribute('aria-expanded', 'false')
    const overflow = await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth > innerWidth,
      vertical: document.documentElement.scrollHeight > innerHeight,
    }))
    expect(overflow).toEqual({ horizontal: false, vertical: false })
  })
}

test('supports visible keyboard focus, photo selection, and adjustment groups', async ({
  luma,
}) => {
  const { page } = luma
  await importPhotos(luma.app, page)
  const firstPhoto = page.getByRole('button', { name: 'Select mountain-ridge.jpg', exact: true })
  const secondPhoto = page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true })
  await firstPhoto.focus()
  await page.keyboard.press('Tab')
  await expect(secondPhoto).toBeFocused()
  const focusStyle = await secondPhoto.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    }
  })
  expect(focusStyle.focusVisible).toBe(true)
  expect(focusStyle.outlineStyle).not.toBe('none')
  expect(focusStyle.outlineWidth).toBeGreaterThan(0)
  await page.keyboard.press('Enter')
  await expect(secondPhoto).toHaveAttribute('aria-pressed', 'true')

  const lightGroup = page.getByRole('button', { name: 'Light', exact: true })
  await lightGroup.click()
  await expect(lightGroup).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeHidden()
  await lightGroup.press('Enter')
  await expect(lightGroup).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeVisible()
})
