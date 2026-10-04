import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'

test.use({ hdrImports: true })
test('supplied Sony brackets review, publish, open and survive source deletion through the UI', async ({
  luma,
}, info) => {
  test.skip(
    !process.env.LUMA_MERGE_BRACKETS,
    'Supply a read-only Sony bracket sequence explicitly.',
  )
  test.setTimeout(360000)
  const paths = JSON.parse(process.env.LUMA_MERGE_BRACKETS!) as string[]
  await isolateTrash(luma.app)
  await importPhotos(luma.app, luma.page, paths, false)
  const { page } = luma,
    photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page
    .getByTestId(`photo-card-${photos[photos.length - 1].id}`)
    .click({ modifiers: ['Shift'] })
  const native = await luma.app.browserWindow(page)
  await native.evaluate((w) => {
    w.unmaximize()
    w.setContentSize(1100, 700)
  })
  await page.getByTestId('console-toggle').click()
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Merge to HDR…' }).click()
  await expect(page.getByRole('checkbox', { name: 'Auto Align', exact: true })).toBeChecked({
    timeout: 30000,
  })
  const merge = page.getByRole('button', { name: 'Merge', exact: true })
  try {
    await expect
      .poll(async () => (await merge.isEnabled()) || (await page.getByRole('alert').count()) > 0, {
        timeout: 180000,
      })
      .toBe(true)
    await expect(merge).toBeEnabled()
  } catch (error) {
    const review = await page.evaluate(() => window.luma.getActiveMergeReview())
    if (review) {
      const diagnostics = await page.evaluate(
        (r) => window.luma.getMergeDiagnostics(r.id, r.revision),
        review,
      )
      await info.attach('alignment-diagnostics', {
        body: JSON.stringify(diagnostics, null, 2),
        contentType: 'application/json',
      })
    }
    throw error
  }
  await expect(page.getByRole('dialog')).toContainText('Reduced preview')
  const readyReview = await page.evaluate(() => window.luma.getActiveMergeReview())
  await info.attach('alignment-diagnostics', {
    body: JSON.stringify(
      await page.evaluate((r) => window.luma.getMergeDiagnostics(r!.id, r!.revision), readyReview),
      null,
      2,
    ),
    contentType: 'application/json',
  })
  const strength = page.getByRole('spinbutton', { name: 'Deghost strength value' })
  await strength.fill('72')
  await strength.press('Escape')
  await expect(strength).toHaveValue('50')
  await page.getByRole('checkbox', { name: 'Show deghost overlay' }).check()
  expect((await page.evaluate(() => window.luma.getActiveMergeReview()))?.revision).toBe(
    readyReview!.revision,
  )
  await expect(merge).toBeEnabled()
  await page.screenshot({ path: info.outputPath('merge-review-1100x700.png') })
  if (process.env.LUMA_MERGE_SKIP_DETAIL !== '1') {
    await page.getByRole('button', { name: 'Native detail (100%)' }).click()
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Fit preview', exact: true }),
    ).toBeVisible({ timeout: 100000 })
    await expect(merge).toBeEnabled()
  }
  await merge.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('selection-count')).toHaveText(`${paths.length} selected`)
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.luma.listTasks())).find((t) => t.kind === 'merge')
          ?.finishedAt,
      { timeout: 120000 },
    )
    .toBeTruthy()
  await page.getByTestId('task-progress').click()
  await page.getByRole('button', { name: 'Open result', exact: true }).click()
  const result = (await page.evaluate(() => window.luma.listPhotos())).photos.find(
    (p) => p.assetKind === 'derived',
  )!
  expect(result).toBeTruthy()
  await cp(
    join(luma.userDataDir, 'library', 'originals', result.id),
    info.outputPath('published-master'),
    { recursive: true },
  )
  expect(await page.evaluate((id) => window.luma.getEdits(id), result.id)).toMatchObject({
    referenceWhiteBalance: true,
    revision: 0,
    settings: { exposureEv: 0, contrast: 0, highlights: 0 },
  })
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
    timeout: 45000,
  })
  const adjusted = await page.evaluate(
    (id) =>
      window.luma.updateEdits(id, { whiteBalance: { mode: 'custom', kelvin: 7000, tint: 10 } }, 0),
    result.id,
  )
  expect(adjusted.settings.whiteBalance).toMatchObject({ mode: 'custom', kelvin: 7000, tint: 10 })
  await page.evaluate((id) => window.luma.undoEdit(id, 1), result.id)
  await page.evaluate(
    (ids) => window.luma.deletePhotos(ids),
    photos.map((p) => p.id),
  )
  await expect.poll(async () => (await page.evaluate(() => window.luma.listPhotos())).total).toBe(1)
  expect(await page.evaluate((id) => window.luma.getMergeProvenance(id), result.id)).toMatchObject({
    reproducible: false,
  })
  const restarted = await luma.restart(true)
  await expect(restarted.page.getByTestId('main-preview')).toHaveAttribute(
    'data-editing',
    'ready',
    { timeout: 45000 },
  )
  expect((await restarted.page.evaluate(() => window.luma.listPhotos())).photos[0].id).toBe(
    result.id,
  )
  const statistics = await restarted.page.evaluate(
    (id) => window.luma.getPhotoStatistics(id, 2, { domain: 'working-hdr' }),
    result.id,
  )
  expect(statistics.exact).toBe(true)
  expect(statistics.visiblePixels).toBe(result.width * result.height)
  expect(statistics.sourceSaturation).toBeNull()
  expect(
    (await restarted.page.evaluate((id) => window.luma.getEdits(id), result.id)).settings
      .whiteBalance.mode,
  ).toBe('as-shot')
})
