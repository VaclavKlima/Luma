import type { ElectronApplication } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('opens cached photos with only a matching blurred placeholder, including after reload', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page)
  const viewport = page.getByTestId('preview-viewport')
  await page.getByRole('button', { name: 'Select mountain-ridge.jpg', exact: true }).click()
  await expect(viewport).toHaveAttribute('data-resolution', 'full')
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('preview:request')
    ipcMain.handle('preview:request', () => ({ error: 'Unexpected full-preview generation' }))
  })
  await page.evaluate(() => {
    const original = window.fetch
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/full/')) throw new Error('Unexpected reload of a warm bitmap')
      return original(...args)
    }
  })
  await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
  await expect(viewport).toHaveAttribute('data-resolution', 'full')
  await expect(page.getByTestId('main-preview')).toBeVisible()
  await expect(page.getByTestId('preview-placeholder')).toHaveCount(0)
  // Reload drops the bounded bitmap cache while preserving the leased disk cache.
  await page.addInitScript(() => {
    const original = window.fetch
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    ;(window as unknown as { releaseFrame: () => void }).releaseFrame = release
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/full/')) await pending
      return original(...args)
    }
  })
  await page.reload()
  try {
    await expect(viewport).toHaveAttribute('data-resolution', 'placeholder')
    const placeholder = page.getByTestId('preview-placeholder')
    await expect(placeholder).toBeVisible()
    const placeholderUrl = (await placeholder.getAttribute('src'))!
    expect(placeholderUrl).toContain('/placeholder/v3/')
    await expect(page.getByTestId('main-preview')).not.toBeVisible()
    await expect(viewport.locator('img[src*="/preview"]')).toHaveCount(0)
    await page.evaluate(() => (window as unknown as { releaseFrame: () => void }).releaseFrame())
    await expect(viewport).toHaveAttribute('data-resolution', 'full')
    await expect(page.getByTestId('main-preview')).toHaveAttribute(
      'data-src',
      placeholderUrl.replace('/placeholder/', '/full/'),
    )
    await expect(placeholder).toHaveCount(0)
  } finally {
    await page.evaluate(() => (window as unknown as { releaseFrame: () => void }).releaseFrame())
  }
})

// Delay the trusted handler, keeping actual cache, worker and protocol behavior behind the gate.
async function holdFullPreview(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('preview:request')!
    let release!: () => void
    let failure = false
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    ipcMain.removeHandler('preview:request')
    ipcMain.handle('preview:request', async (...args) => {
      await pending
      return failure ? { error: 'Preview generation timed out.' } : original(...args)
    })
    return {
      release: () => release(),
      fail: () => {
        failure = true
      },
      succeed: () => {
        failure = false
      },
    }
  })
}

test('shows a neutral loader on first RAW opening and then native full-resolution pixels', async ({
  luma,
}, info) => {
  const { app, page } = luma
  const gate = await holdFullPreview(app)
  try {
    await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
    const viewport = page.getByTestId('preview-viewport')
    const zoom = page.getByRole('combobox', { name: 'Preview zoom' })
    await expect(page.getByTestId('preview-resolution')).toContainText('Loading full resolution…')
    await expect(viewport).toHaveAttribute('data-resolution', 'loading')
    await expect(zoom).toBeDisabled()
    await expect(viewport.locator('img')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('raw-loading.png') })
    await gate.evaluate((control) => control.release())
    await expect(viewport).toHaveAttribute('data-resolution', 'full', { timeout: 20000 })
    await zoom.selectOption('1')
    const dimensions = await page.getByTestId('main-preview').evaluate((element) => ({
      width: (element as HTMLCanvasElement).width,
      height: (element as HTMLCanvasElement).height,
      displayed: element.getBoundingClientRect().width,
    }))
    expect(dimensions).toEqual({ width: 5422, height: 3622, displayed: 5422 })
    await page.screenshot({ path: info.outputPath('raw-full-100.png') })
  } finally {
    await gate.evaluate((control) => control.release())
    await gate.dispose()
  }
})

test('shows an error without camera JPEG fallback, retries, and repairs corrupt RGBA frames', async ({
  luma,
}) => {
  const { app, page } = luma
  const gate = await holdFullPreview(app)
  try {
    await gate.evaluate((control) => control.fail())
    await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], false)
    await gate.evaluate((control) => control.release())
    await expect(page.getByTestId('preview-resolution')).toContainText(
      'Full resolution unavailable',
    )
    await expect(page.getByTestId('main-preview')).not.toBeVisible()
    await expect(page.getByTestId('preview-viewport').locator('img')).toHaveCount(0)
    await gate.evaluate((control) => control.succeed())
    await page
      .getByTestId('preview-resolution')
      .getByRole('button', { name: 'Retry', exact: true })
      .click()
    await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
    await expect(page.getByRole('combobox', { name: 'Preview zoom' })).toHaveValue('fit')
    const url = new URL((await page.getByTestId('main-preview').getAttribute('data-src'))!)
    const [id, , version, revision] = url.pathname.slice(1).split('/')
    const cacheFile = join(
      luma.userDataDir,
      'library',
      'cache',
      'previews',
      version,
      `${id}-${revision}`,
      'full.rgba',
    )
    // Same length bypasses the inexpensive file-size check and exercises the frame integrity check.
    const bytes = await readFile(cacheFile)
    await writeFile(cacheFile, Buffer.alloc(bytes.length))
    await app.evaluate(async ({ session }) => session.defaultSession.clearCache())
    await page.reload()
    await expect(page.getByTestId('preview-resolution')).toContainText(
      'Full resolution unavailable',
    )
    await expect(page.getByTestId('main-preview')).not.toBeVisible()
    await page
      .getByTestId('preview-resolution')
      .getByRole('button', { name: 'Retry', exact: true })
      .click()
    await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
    expect(await page.getByTestId('main-preview').getAttribute('data-src')).not.toBe(url.toString())
    // A broken quick preview must not prevent a valid full-resolution image from loading.
    await writeFile(
      join(luma.userDataDir, 'library', 'originals', id, 'preview.jpg'),
      'Invalid JPEG',
    )
    await app.evaluate(async ({ session }) => session.defaultSession.clearCache())
    await page.reload()
    await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
    await expect(page.getByTestId('main-preview')).toBeVisible()
  } finally {
    await gate.evaluate((control) => control.release())
    await gate.dispose()
  }
})

test('accepts only the current photo after rapid navigation and permits imports while detail is pending', async ({
  luma,
}, info) => {
  const { app, page } = luma
  const gate = await holdFullPreview(app)
  try {
    await importPhotos(app, page, undefined, false)
    for (const filename of ['mountain-ridge.jpg', 'alpine-lake.jpg', 'mountain-ridge.jpg'])
      await page.getByRole('button', { name: `Select ${filename}`, exact: true }).click()
    await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], false)
    await expect(page.getByTestId('preview-filename')).toHaveText('mountain-ridge.jpg')
    await gate.evaluate((control) => control.release())
    await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
    const { photos } = await page.evaluate(() => window.luma.listPhotos())
    const selected = photos.find((photo) => photo.filename === 'mountain-ridge.jpg')!
    await expect(page.getByTestId('main-preview')).toHaveAttribute(
      'data-src',
      new RegExp(`/${selected.id}/full/`),
    )
    const nativeWindow = await app.browserWindow(page)
    await nativeWindow.evaluate((window) => {
      window.unmaximize()
      window.setContentSize(1100, 700)
    })
    await page.getByTestId('console-toggle').click()
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
    const status = await page.getByTestId('preview-resolution').boundingBox()
    expect(status!.x + status!.width).toBeLessThan(1100)
    expect(status!.y + status!.height).toBeLessThan(700)
    await page.screenshot({ path: info.outputPath('full-preview-1100x700.png') })
  } finally {
    await gate.evaluate((control) => control.release())
    await gate.dispose()
  }
})
