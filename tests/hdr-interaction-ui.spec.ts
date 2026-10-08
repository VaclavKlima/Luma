import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { HDR_CACHE_MAX_TILES } from '../src/renderer/src/preview/hdr-render-cache'

test.use({ hdrDisplay: true })
test('HDR interaction reuses rendered tiles, invalidates edits and targets, and preserves native detail', async ({
  luma,
}) => {
  test.setTimeout(120000)
  const { app, page } = luma
  await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
  const canvas = page.getByTestId('main-preview'),
    viewport = page.getByTestId('preview-viewport')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-quality', 'normal')
  const drawView = async (key: string) => {
    const before = Number(await canvas.getAttribute('data-requested-serial'))
    await canvas.press(key)
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-requested-serial')))
      .toBeGreaterThan(before)
    await expect
      .poll(() =>
        canvas.evaluate(
          (element) =>
            element.dataset.quality === 'normal' &&
            element.dataset.completedEditSerial === element.dataset.requestedSerial,
        ),
      )
      .toBe(true)
  }
  await canvas.focus()
  await drawView('1')
  await expect(viewport).toHaveAttribute('data-scale', '1')
  const completed = async () =>
    page.evaluate(async () => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
      await c.getContext('webgpu')!.getConfiguration()!.device.queue.onSubmittedWorkDone()
      return {
        rendered: Number(c.dataset.renderedTiles),
        serial: Number(c.dataset.presentationSerial),
        cached: Number(c.dataset.cachedTiles),
      }
    })
  // Warm adjacent tiles, then return to the same view.
  await drawView('ArrowRight')
  await drawView('ArrowLeft')
  const before = await completed()
  for (const key of ['ArrowRight', 'ArrowLeft', '+', '-']) await drawView(key)
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-presentation-serial')))
    .toBeGreaterThan(before.serial)
  const after = await completed()
  expect(after.rendered).toBe(before.rendered)
  expect(after.cached).toBeLessThanOrEqual(HDR_CACHE_MAX_TILES)
  const source = (await page.evaluate(() => window.luma.getPreviewDiagnostics())).renderingIdentity
  await page.getByTestId('console-toggle').click()
  await expect(viewport).toHaveAttribute('data-scale', '1')
  await page.getByRole('spinbutton', { name: 'Exposure value' }).fill('1')
  await page.getByRole('spinbutton', { name: 'Exposure value' }).press('Enter')
  await expect(canvas).toHaveAttribute('data-exposure', '1')
  expect((await completed()).rendered).toBeGreaterThan(after.rendered)
  expect((await page.evaluate(() => window.luma.getPreviewDiagnostics())).renderingIdentity).toBe(
    source,
  )
  await page.getByRole('combobox', { name: 'Preview display mode' }).selectOption('sdr')
  await expect
    .poll(() => page.evaluate(() => window.luma.getDisplayState()))
    .toMatchObject({ mode: 'sdr', peak: 1 })
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await expect(viewport).toHaveAttribute('data-scale', '1')
  await page.getByRole('button', { name: 'Before', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-comparison', 'before')
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
})
